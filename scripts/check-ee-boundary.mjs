#!/usr/bin/env node
/**
 * Open-core boundary: no file outside ee/ imports from ee/.
 *
 * The MIT core must build and run with the ee/ folder deleted, so its code never names ee/: no static or dynamic
 * import, export-from, require, import.meta.resolve or `import("...")` type whose specifier resolves into the
 * repository's ee/ folder (relative or absolute) or names an ee package (`@veyraco/fingers-ee`). The core finds the
 * built ee module at run time instead (packages/coding-agent/src/core/edition/loader.ts). ee/ may import the core.
 *
 * Usage: node scripts/check-ee-boundary.mjs [root]
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_FILE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const IGNORED_DIRECTORIES = new Set([".git", ".wt", "coverage", "dist", "node_modules"]);
/** Holds example violations as data. */
const IGNORED_FILES = new Set(["scripts/check-ee-boundary.test.mjs"]);
const EE_PACKAGE = /^@veyraco\/fingers-ee(?:\/|$)/;

const SPECIFIER_PATTERNS = [
	// import x from "…", import { a } from "…", import type { A } from "…", export * from "…", export { a } from "…"
	/\b(?:import|export)\b[^;"'`]*?\bfrom\s*(["'`])([^"'`]+)\1/g,
	// import "…" (side effects)
	/\bimport\s*(["'`])([^"'`]+)\1/g,
	// import("…"), typeof import("…"), require("…"), import.meta.resolve("…"), vi.mock("…")
	/\b(?:import|require|resolve|mock|doMock|importActual)\s*\(\s*(["'`])([^"'`]+)\1/g,
];

function* sourceFiles(directory, root) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (IGNORED_DIRECTORIES.has(entry.name)) continue;
			if (relative(root, path) === "ee") continue;
			yield* sourceFiles(path, root);
		} else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
			yield path;
		}
	}
}

/** The specifiers a source text imports from, with their line numbers. */
export function importSpecifiers(text) {
	const found = [];
	for (const pattern of SPECIFIER_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			const line = text.slice(0, match.index).split("\n").length;
			found.push({ specifier: match[2], line });
		}
	}
	return found;
}

/** True when `specifier`, written in `file`, points into `<root>/ee` or at an ee package. */
export function pointsIntoEe(specifier, file, root) {
	if (EE_PACKAGE.test(specifier)) return true;
	let target;
	if (specifier.startsWith("file://")) {
		try {
			target = fileURLToPath(specifier);
		} catch {
			return false;
		}
	} else if (specifier.startsWith(".")) target = resolve(dirname(file), specifier);
	else if (isAbsolute(specifier)) target = specifier;
	else return false;
	const fromRoot = relative(resolve(root), target);
	return fromRoot === "ee" || fromRoot.startsWith(`ee${sep}`) || fromRoot.startsWith("ee/");
}

/** Every import of ee/ from outside it, as "path:line specifier". */
export function findEeImports(root) {
	const violations = [];
	for (const file of sourceFiles(root, root)) {
		const path = relative(root, file).split(sep).join("/");
		if (IGNORED_FILES.has(path)) continue;
		const text = readFileSync(file, "utf8");
		for (const { specifier, line } of importSpecifiers(text)) {
			if (pointsIntoEe(specifier, file, root)) violations.push(`${path}:${line} imports ${specifier}`);
		}
	}
	return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
	const violations = findEeImports(root);
	if (violations.length > 0) {
		console.error("The MIT core must not import ee/ (it has to build and run without it):");
		for (const violation of violations) console.error(`  ${violation}`);
		process.exit(1);
	}
	console.log("ee boundary: no file outside ee/ imports from it");
}
