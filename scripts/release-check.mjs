#!/usr/bin/env node
/**
 * Release gate for the publish workflow (.github/workflows/release.yml).
 *
 *   node scripts/release-check.mjs check --tag vX.Y.Z[-pre]   the committed packages may be released under this tag
 *   node scripts/release-check.mjs dist-tag <version>         the npm dist-tag for a version (latest or next)
 *   node scripts/release-check.mjs next-version --run <n>     the prerelease version main publishes for workflow run n
 *
 * A tag never changes versions: `npm run release:<bump>` (scripts/release.mjs) commits them first.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execNpmSync } from "./npm-command.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const VERSION = "(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-([0-9A-Za-z]+(?:\\.[0-9A-Za-z]+)*))?";
const TAG_RE = new RegExp(`^v${VERSION}$`);
const STABLE_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DEPENDENCY_SECTIONS = ["dependencies", "optionalDependencies", "peerDependencies"];

export function parseReleaseTag(tag) {
	const match = TAG_RE.exec(tag);
	if (!match) throw new Error(`${JSON.stringify(tag)} is not a release tag (vX.Y.Z or vX.Y.Z-pre.N)`);
	return { version: tag.slice(1), prerelease: match[4] !== undefined };
}

export function distTagFor(version) {
	return STABLE_RE.test(version) ? "latest" : "next";
}

/** Everything that stops `tag` from releasing `packages`; empty when the release may go ahead. */
export function releaseProblems({ tag, packages, changelog }) {
	const { version, prerelease } = parseReleaseTag(tag);
	const problems = [];
	const names = new Set(packages.map((pkg) => pkg.name));
	for (const pkg of packages) {
		if (pkg.version !== version) problems.push(`${pkg.name} is ${pkg.version}, the tag says ${version}`);
	}
	for (const pkg of packages) {
		for (const section of DEPENDENCY_SECTIONS) {
			for (const [dependency, specifier] of Object.entries(pkg[section] ?? {})) {
				if (names.has(dependency) && specifier !== version) {
					problems.push(`${pkg.name} depends on ${dependency} ${specifier}, not ${version}`);
				}
			}
		}
	}
	if (!prerelease && !changelog.includes(`## [${version}]`)) {
		problems.push(`packages/coding-agent/CHANGELOG.md has no ## [${version}] section`);
	}
	return problems;
}

/**
 * The version main publishes under `next` for a workflow run: the committed version while it is
 * unpublished, otherwise the next patch, so `next` always sorts above `latest`.
 */
export function nextPrereleaseVersion({ current, published, run }) {
	if (!/^[1-9]\d*$/.test(String(run))) throw new Error(`The run number must be a positive integer, got ${JSON.stringify(run)}`);
	const match = STABLE_RE.exec(current);
	if (!match) throw new Error(`The committed version must be a stable version, got ${current}`);
	const base = published ? `${match[1]}.${match[2]}.${Number(match[3]) + 1}` : current;
	return `${base}-next.${run}`;
}

function readPackages(repoRoot) {
	return getPublicWorkspacePackages(join(repoRoot, "packages")).map(({ directory }) =>
		JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
	);
}

function isPublished(name, version) {
	try {
		return execNpmSync(["view", `${name}@${version}`, "version", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() !== "";
	} catch (error) {
		const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`;
		if (output.includes("E404") || output.includes("404 Not Found")) return false;
		throw error;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const [command, ...rest] = process.argv.slice(2);
	const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { tag: { type: "string" }, run: { type: "string" } } });
	if (command === "check" && values.tag) {
		const changelog = readFileSync(join(repoRoot, "packages/coding-agent/CHANGELOG.md"), "utf8");
		const problems = releaseProblems({ tag: values.tag, packages: readPackages(repoRoot), changelog });
		if (problems.length > 0) {
			console.error(`${values.tag} cannot be released:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
			process.exit(1);
		}
		console.log(`${values.tag} may be released (npm dist-tag ${distTagFor(parseReleaseTag(values.tag).version)}).`);
	} else if (command === "dist-tag" && positionals.length === 1) {
		console.log(distTagFor(positionals[0]));
	} else if (command === "next-version" && values.run) {
		const packages = readPackages(repoRoot);
		const current = packages[0].version;
		const coding = packages.find((pkg) => pkg.name === "@veyraco/fingers") ?? packages[0];
		console.log(nextPrereleaseVersion({ current, published: isPublished(coding.name, current), run: values.run }));
	} else {
		console.error("Usage: release-check.mjs check --tag <tag> | dist-tag <version> | next-version --run <n>");
		process.exit(2);
	}
}
