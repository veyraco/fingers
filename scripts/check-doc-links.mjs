#!/usr/bin/env node
/**
 * Link check for the repository's Markdown: READMEs, the docs in packages/coding-agent/docs, ee/README.md and the
 * other guides.
 *
 * Every relative link and image (Markdown `[text](target)` and HTML `href`/`src`) must point at a file or folder that
 * exists, and a `#fragment` on a link to a Markdown page (or on a link inside the same page) must name one of that
 * page's headings, as GitHub derives the anchor from the heading text, or an `<a id>`/`<a name>` in it. Links to this
 * repository on GitHub (`github.com/veyraco/fingers/blob|tree/main/<path>`) are checked the same way as relative
 * ones. Other web addresses are not fetched. Code blocks and inline code are skipped, and so are changelogs (they
 * record history, including paths that no longer exist).
 *
 * Usage: node scripts/check-doc-links.mjs [root]
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const IGNORED_DIRECTORIES = new Set([".git", ".wt", "coverage", "dist", "node_modules", "fixtures"]);
const IGNORED_FILES = new Set(["CHANGELOG.md"]);
const OWN_REPOSITORY = /^https:\/\/github\.com\/veyraco\/fingers\/(?:blob|tree)\/main\/([^?#)\s]*)(#[^)\s]*)?$/;

function* markdownFiles(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;
			yield* markdownFiles(path);
		} else if (entry.isFile() && entry.name.endsWith(".md") && !IGNORED_FILES.has(entry.name)) {
			yield path;
		}
	}
}

/** The text with fenced code blocks blanked out (lines kept, so line numbers stay right). */
function withoutCodeBlocks(text) {
	let fence = null;
	return text
		.split("\n")
		.map((line) => {
			const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
			if (fence) {
				if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
				return "";
			}
			if (marker) {
				fence = marker;
				return "";
			}
			return line;
		})
		.join("\n");
}

/** GitHub's anchor for a heading: the rendered text, lower case, punctuation dropped, spaces as hyphens. */
export function headingSlug(heading) {
	const text = heading
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/<[^>]+>/g, "")
		.replace(/`/g, "")
		.replace(/(^|\s)[*_]{1,3}(?=\S)|(?<=\S)[*_]{1,3}(?=\s|$)/g, "$1")
		.trim()
		.toLowerCase();
	return text.replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
}

/** Every anchor a Markdown page offers: its headings (repeats get -1, -2, …) and explicit `<a id|name>` targets. */
export function anchorsOf(text) {
	const anchors = new Set();
	const seen = new Map();
	for (const line of withoutCodeBlocks(text).split("\n")) {
		const heading = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/)?.[1];
		if (heading !== undefined) {
			const base = headingSlug(heading);
			const count = seen.get(base) ?? 0;
			seen.set(base, count + 1);
			anchors.add(count === 0 ? base : `${base}-${count}`);
		}
		for (const match of line.matchAll(/<a\s[^>]*\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) anchors.add(match[1]);
	}
	return anchors;
}

/** Links and images of a Markdown text, with their line numbers; code is skipped. */
export function linksOf(text) {
	const links = [];
	const lines = withoutCodeBlocks(text).split("\n");
	lines.forEach((raw, index) => {
		const line = raw.replace(/`[^`]*`/g, (code) => " ".repeat(code.length));
		for (const match of line.matchAll(/!?\[(?:[^\]]|\][^(])*?\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
			links.push({ target: match[1], line: index + 1 });
		}
		for (const match of line.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
			links.push({ target: match[1], line: index + 1 });
		}
		for (const match of line.matchAll(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/g)) {
			links.push({ target: match[1], line: index + 1 });
		}
	});
	return links;
}

/** Problems with one link of `file` (absolute path) inside `root`; an empty list when it is fine or not checked. */
export function linkProblems(root, file, target, read = (path) => readFileSync(path, "utf8")) {
	let path;
	let fragment;
	const own = target.match(OWN_REPOSITORY);
	if (own) {
		path = resolve(root, decodeURIComponent(own[1]));
		fragment = own[2]?.slice(1);
	} else if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("//") || target.startsWith("/")) {
		return [];
	} else {
		const [beforeHash, ...afterHash] = target.split("#");
		const pathPart = beforeHash.split("?")[0];
		fragment = afterHash.length > 0 ? afterHash.join("#") : undefined;
		path = pathPart === "" ? file : resolve(dirname(file), decodeURIComponent(pathPart));
	}
	if (!existsSync(path)) return [`${target}: ${relative(root, path) || "."} does not exist`];
	if (fragment === undefined || fragment === "" || !path.endsWith(".md") || !statSync(path).isFile()) return [];
	const anchors = anchorsOf(read(path));
	const wanted = decodeURIComponent(fragment).toLowerCase();
	return anchors.has(wanted) ? [] : [`${target}: no heading or anchor #${fragment} in ${relative(root, path)}`];
}

/** Every broken link under `root`, as "file:line: problem". */
export function findBrokenLinks(root) {
	const problems = [];
	const cache = new Map();
	const read = (path) => {
		if (!cache.has(path)) cache.set(path, readFileSync(path, "utf8"));
		return cache.get(path);
	};
	for (const file of markdownFiles(root)) {
		for (const { target, line } of linksOf(read(file))) {
			for (const problem of linkProblems(root, file, target, read)) {
				problems.push(`${relative(root, file).split(sep).join("/")}:${line}: ${problem}`);
			}
		}
	}
	return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
	const problems = findBrokenLinks(root);
	if (problems.length > 0) {
		console.error(`Broken Markdown links (${problems.length}):`);
		for (const problem of problems) console.error(`  ${problem}`);
		process.exit(1);
	}
	console.log("Markdown links OK");
}
