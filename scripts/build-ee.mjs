#!/usr/bin/env node
/**
 * Builds Fingers ee (the repository's ee/ folder, Veyra Fingers Enterprise License) into
 * packages/coding-agent/dist/ee/: index.js (one ES module) and LICENSE next to it, so the published package ships
 * the ee code with its own license (scripts/check-package-tarballs.mjs checks that).
 *
 * Without the ee/ folder (a core-only checkout) it removes any dist/ee/ left from an earlier build and stops.
 * The ee module may use the core only through what the core hands it at run time (EeHost): a runtime import of a
 * Fingers package fails the build.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CORE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](@veyraco\/[^"']+)["']/;

export async function buildEe({ root = repoRoot, outDir = join(root, "packages", "coding-agent", "dist", "ee") } = {}) {
	const eeDir = join(root, "ee");
	if (!existsSync(join(eeDir, "src", "index.ts"))) {
		rmSync(outDir, { recursive: true, force: true });
		return { built: false };
	}
	mkdirSync(outDir, { recursive: true });
	const outfile = join(outDir, "index.js");
	await build({
		absWorkingDir: root,
		entryPoints: [join(eeDir, "src", "index.ts")],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		external: ["@veyraco/*"],
		banner: {
			js: "// Fingers ee. Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (./LICENSE); not MIT.",
		},
		logLevel: "error",
	});
	const coreImport = readFileSync(outfile, "utf8").match(CORE_IMPORT);
	if (coreImport) {
		rmSync(outDir, { recursive: true, force: true });
		throw new Error(
			`ee/ imports ${coreImport[1]} at run time; ee code may use the core only through the EeHost it is handed (import type only)`,
		);
	}
	copyFileSync(join(eeDir, "LICENSE"), join(outDir, "LICENSE"));
	return { built: true, outfile };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const result = await buildEe();
	console.log(result.built ? `ee built: ${result.outfile}` : "no ee/ folder: core only, nothing to build");
}
