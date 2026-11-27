import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { scanText } from "./check-secrets.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "check-secrets.mjs");
// Built at run time so this file holds no credential-shaped literal itself.
const random = (length, alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789") =>
	Array.from({ length }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join("");

function repo(files, commit = true) {
	const root = mkdtempSync(join(tmpdir(), "fingers-secrets-"));
	execFileSync("git", ["init", "-q", root]);
	for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
	execFileSync("git", ["-C", root, "add", "."]);
	if (commit) {
		execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "c"]);
	}
	return root;
}

describe("secret scan", () => {
	it("finds provider keys, tokens and a real-sized private key", () => {
		const text = [
			`sk-ant-api03-${random(40)}`,
			`gh${"p"}_${random(36)}`,
			`AKIA${random(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`,
			`xox${"b"}-${random(24)}`,
			`-----BEGIN PRIVATE KEY-----\n${random(64)}\n-----END PRIVATE KEY-----`,
		].join("\n");
		assert.deepEqual(
			scanText(text)
				.map(([kind]) => kind)
				.sort(),
			["AWS access key", "Anthropic key", "GitHub token", "Slack token", "private key"],
		);
	});

	it("finds a real-sized private key written on one line with escaped newlines", () => {
		const oneLine = `"-----BEGIN PRIVATE KEY-----\\n${random(64)}\\n-----END PRIVATE KEY-----"`;
		assert.deepEqual(
			scanText(oneLine).map(([kind]) => kind),
			["private key"],
		);
	});

	it("passes the listed fake values and a one-line toy key", () => {
		const toy = '"-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEA7bq3secretkeybody\\n-----END RSA PRIVATE KEY-----"';
		assert.deepEqual(scanText(`apiKey: "AIzaSyExampleRealisticLookingApiKey123456"\n${toy}`), []);
	});

	it("fails on a committed key in the tracked files and in history, and shows only a prefix", () => {
		const key = `sk-ant-api03-${random(48)}`;
		const root = repo({ "a.txt": `ANTHROPIC_API_KEY=${key}\n` });
		try {
			for (const args of [[], ["--history"]]) {
				const result = spawnSync(process.execPath, [script, "--root", root, ...args], { encoding: "utf8" });
				assert.equal(result.status, 1, result.stdout + result.stderr);
				assert.match(result.stderr, /a\.txt: Anthropic key sk-ant-a…\(61 chars\)/);
				assert.equal(result.stderr.includes(key), false);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("passes a clean repository", () => {
		const root = repo({ "a.txt": "nothing to see\n" });
		try {
			const result = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /no findings/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
