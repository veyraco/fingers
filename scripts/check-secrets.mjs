#!/usr/bin/env node
// Secret scan for this public repository: provider keys, tokens and private keys must never be committed.
// Scans the tracked files, or with --history the lines every commit added. Test fixtures pass only as the
// fake values listed in ALLOWED (redaction tests need realistic-looking keys).
// Usage: node scripts/check-secrets.mjs [--history] [--root <dir>]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Credential shapes: name, pattern. */
export const SECRETS = [
	["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/g],
	["OpenAI key", /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}/g],
	["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
	["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
	["Google API key", /\bAIza[0-9A-Za-z_-]{35}/g],
	["Google OAuth token", /\bya29\.[0-9A-Za-z_-]{20,}/g],
	["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
	["Stripe key", /\b[rs]k_live_[0-9a-zA-Z]{20,}/g],
	["npm token", /\bnpm_[A-Za-z0-9]{36}\b/g],
	["Hugging Face token", /\bhf_[A-Za-z0-9]{30,}/g],
	["GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}/g],
	["JSON Web Token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
];

/** The fake values tests use on purpose. Anything else that matches is a finding. */
export const ALLOWED = new Set([
	"AIzaSyExampleRealisticLookingApiKey123456",
	"sk-ant-oat-veyra-hands-subscription",
	"sk-ant-api03-very-secret-key-0123456789",
	"sk-ant-api03-Zq9xV2mN8bL4kP7wR1tY6uI3oE5aS0dF",
	"ghp_abcdefghijklmnopqrstuvwxyz0123456789",
	"AKIAABCDEFGHIJKLMNOP",
]);

/** A match is allowed when it is one of the fake values or a prefix of one (a pattern stops at its length). */
const isAllowed = (value) => [...ALLOWED].some((fake) => fake.startsWith(value));

const SKIP = [/^package-lock\.json$/, /(^|\/)install-lock\/package-lock\.json$/, /\.(png|gif|jpe?g|webp|ico|wasm|node|woff2?|gz|zip)$/i];

/**
 * A private key header is a finding unless it is a one-line toy: its END marker on the same line and a body too
 * short for any real key (the smallest, Ed25519 PKCS#8, has 64 base64 characters).
 */
function pemFindings(text) {
	const found = [];
	for (const match of text.matchAll(/-----BEGIN ([A-Z ]*)PRIVATE KEY-----/g)) {
		const rest = text.slice(match.index + match[0].length);
		const end = rest.search(/-----END [A-Z ]*PRIVATE KEY-----/);
		const body = end < 0 ? rest : rest.slice(0, end);
		const base64 = body.replace(/\\n|\s/g, "");
		const oneLine = !/\n/.test(body.replace(/\\n/g, ""));
		if (end < 0 || !oneLine || base64.length >= 48) found.push(["private key", match[0]]);
	}
	return found;
}

/** Findings in one text: [kind, value]. */
export function scanText(text) {
	const found = [];
	for (const [kind, pattern] of SECRETS) {
		for (const match of text.matchAll(pattern)) if (!isAllowed(match[0])) found.push([kind, match[0]]);
	}
	return [...found, ...pemFindings(text)];
}

const redact = (value) => `${value.slice(0, 8)}…(${value.length} chars)`;

function scanTree(root) {
	const files = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
	const findings = [];
	for (const file of files) {
		if (SKIP.some((pattern) => pattern.test(file))) continue;
		let text;
		try {
			text = readFileSync(join(root, file), "utf8");
		} catch {
			continue; // deleted in the working tree
		}
		for (const [kind, value] of scanText(text)) findings.push(`${file}: ${kind} ${redact(value)}`);
	}
	return findings;
}

function scanHistory(root) {
	const log = execFileSync("git", ["-C", root, "log", "--all", "-p", "--no-color", "--no-ext-diff", "--format=commit %H"], {
		encoding: "utf8",
		maxBuffer: 1024 * 1024 * 1024,
	});
	const findings = new Set();
	let commit = "";
	let file = "";
	let added = [];
	const flush = () => {
		if (!file || added.length === 0 || SKIP.some((pattern) => pattern.test(file))) return;
		for (const [kind, value] of scanText(added.join("\n"))) findings.add(`${commit.slice(0, 10)} ${file}: ${kind} ${redact(value)}`);
	};
	for (const line of log.split("\n")) {
		if (line.startsWith("commit ")) {
			flush();
			commit = line.slice(7);
			file = "";
			added = [];
		} else if (line.startsWith("+++ ")) {
			flush();
			file = line.startsWith("+++ b/") ? line.slice(6) : "";
			added = [];
		} else if (line.startsWith("+") && file) {
			added.push(line.slice(1));
		}
	}
	flush();
	return [...findings];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const rootIndex = args.indexOf("--root");
	const root = rootIndex >= 0 ? resolve(args[rootIndex + 1]) : resolve(fileURLToPath(import.meta.url), "../..");
	const history = args.includes("--history");
	const findings = history ? scanHistory(root) : scanTree(root);
	if (findings.length > 0) {
		console.error(`Secret scan (${history ? "history" : "tracked files"}): ${findings.length} finding(s)`);
		for (const finding of findings) console.error(`  ${finding}`);
		process.exit(1);
	}
	console.log(`Secret scan (${history ? "history" : "tracked files"}): no findings`);
}
