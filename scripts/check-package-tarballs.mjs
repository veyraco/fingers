#!/usr/bin/env node
/**
 * Checks what each published Fingers tarball holds:
 * - LICENSE at the package root, the same text as the repository LICENSE;
 * - ee/LICENSE wherever ee/ code ships (the ee/ packages carry their own license);
 * - no source maps, no tests, no local secrets, sessions or logs.
 *
 * Usage:
 *   node scripts/check-package-tarballs.mjs                      every public package as `npm pack` would pack it
 *   node scripts/check-package-tarballs.mjs --manifest <path>    the tarballs of an artifact set (scripts/package-artifacts.mjs)
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execNpmSync } from "./npm-command.mjs";
import { readArtifactSet } from "./package-artifacts.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const TEST_FILE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const LOCAL_FILE = /(^|\/)(\.env(\..*)?|\.npmrc|auth\.json)$|\.(jsonl|log)$/;

/** Problems with one package's file list; an empty array means the tarball may be published. */
export function tarballViolations({ name, files, license, rootLicense }) {
	const problems = [];
	if (!files.includes("LICENSE") || license === undefined) problems.push(`${name}: LICENSE is missing`);
	else if (license !== rootLicense) problems.push(`${name}: LICENSE differs from the repository LICENSE`);
	for (const file of files) {
		if (file.endsWith(".map")) problems.push(`${name}: source map ${file}`);
		else if (TEST_FILE.test(file)) problems.push(`${name}: test file ${file}`);
		else if (LOCAL_FILE.test(file)) problems.push(`${name}: local file ${file}`);
	}
	const eeRoots = new Set();
	for (const file of files) {
		const match = /^((?:.*\/)?ee)\//.exec(file);
		if (match) eeRoots.add(match[1]);
	}
	for (const eeRoot of eeRoots) {
		if (!files.includes(`${eeRoot}/LICENSE`)) problems.push(`${name}: ${eeRoot}/ ships without ${eeRoot}/LICENSE`);
	}
	return problems;
}

/** The files `npm pack` would put in the package at `directory`, relative to the package root. */
export function listPackFiles(directory) {
	const output = execNpmSync(["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: directory,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const [packed] = JSON.parse(output);
	return packed.files.map((file) => file.path.replaceAll("\\", "/"));
}

/** The files inside a packed tarball, relative to the package root (npm tarballs wrap everything in package/). */
export function listTarballFiles(tarballPath) {
	return execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
		.split("\n")
		.filter((entry) => entry && !entry.endsWith("/"))
		.map((entry) => entry.replace(/^package\//, ""));
}

function readTarballFile(tarballPath, file) {
	try {
		return execFileSync("tar", ["-xzOf", tarballPath, `package/${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return undefined;
	}
}

function readOptional(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

export function checkWorkspace(repoRoot) {
	const rootLicense = readFileSync(join(repoRoot, "LICENSE"), "utf8");
	return getPublicWorkspacePackages(join(repoRoot, "packages")).flatMap((pkg) =>
		tarballViolations({
			name: pkg.name,
			files: listPackFiles(pkg.directory),
			license: readOptional(join(pkg.directory, "LICENSE")),
			rootLicense,
		}),
	);
}

export function checkArtifactSet(manifestPath, repoRoot) {
	const rootLicense = readFileSync(join(repoRoot, "LICENSE"), "utf8");
	return readArtifactSet(manifestPath).packages.flatMap((pkg) =>
		tarballViolations({
			name: pkg.name,
			files: listTarballFiles(pkg.tarballPath),
			license: readTarballFile(pkg.tarballPath, "LICENSE"),
			rootLicense,
		}),
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({ options: { manifest: { type: "string" } } });
	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const problems = values.manifest ? checkArtifactSet(values.manifest, repoRoot) : checkWorkspace(repoRoot);
	if (problems.length > 0) {
		console.error(`Package tarballs are not ready to publish:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
		process.exit(1);
	}
	console.log(values.manifest ? `Checked the tarballs in ${values.manifest}.` : "Checked every public package's tarball contents.");
}
