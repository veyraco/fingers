#!/usr/bin/env node
/**
 * Prepares the build context of the ghcr.io/veyraco/fingers image (docker/fingers/Dockerfile)
 * from a release artifact set (scripts/package-artifacts.mjs):
 *
 *   <out>/install/package.json        the coding-agent install lock's root, Fingers packages as file: tarballs
 *   <out>/install/package-lock.json   the install lock, Fingers packages resolved to the tarballs
 *   <out>/install/tarballs/*.tgz      the release tarballs
 *
 * `npm ci` in <out>/install then installs exactly the release's Fingers packages and the locked
 * third-party dependencies (versions and integrity from packages/coding-agent/install-lock), so the
 * image never waits for, or trusts, the npm publish of the same release.
 *
 * Usage: node scripts/image-install-root.mjs --manifest <artifact manifest.json> --out <dir>
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readArtifactSet } from "./package-artifacts.mjs";

const INTERNAL_PREFIX = "@veyraco/fingers";
const DEPENDENCY_SECTIONS = ["dependencies", "optionalDependencies", "peerDependencies"];

function lockPackageName(path) {
	const index = path.lastIndexOf("node_modules/");
	return index === -1 ? undefined : path.slice(index + "node_modules/".length);
}

function isInternal(name) {
	return name === INTERNAL_PREFIX || name?.startsWith(`${INTERNAL_PREFIX}-`);
}

/**
 * Rewrites the install lock for a release: every Fingers package resolves to its tarball
 * (`file`, relative to the install root) at the release version with the tarball's integrity;
 * everything else stays as locked.
 */
export function buildInstallLock({ packageJson, lock, artifacts }) {
	const versions = new Set(artifacts.map((artifact) => artifact.version));
	if (versions.size !== 1) throw new Error(`Release packages are not lockstep versioned: ${[...versions].join(", ")}`);
	const [version] = versions;
	const byName = new Map(artifacts.map((artifact) => [artifact.name, artifact]));
	const specifier = (name) => `file:${byName.get(name).file}`;

	const nextPackageJson = structuredClone(packageJson);
	const nextLock = structuredClone(lock);
	const direct = new Set();
	for (const [name] of Object.entries(nextPackageJson.dependencies ?? {})) {
		if (!isInternal(name)) continue;
		if (!byName.has(name)) throw new Error(`${name} is in the install lock but not in the release`);
		nextPackageJson.dependencies[name] = specifier(name);
		direct.add(name);
	}
	nextPackageJson.version = version;
	nextPackageJson.overrides = { ...nextPackageJson.overrides };
	for (const name of byName.keys()) {
		if (!direct.has(name)) nextPackageJson.overrides[name] = specifier(name);
	}

	for (const [path, entry] of Object.entries(nextLock.packages)) {
		if (path === "") {
			entry.version = version;
			entry.dependencies = { ...nextPackageJson.dependencies };
			continue;
		}
		const name = lockPackageName(path);
		if (isInternal(name)) {
			const artifact = byName.get(name);
			if (!artifact) throw new Error(`${name} is in the install lock but not in the release`);
			entry.version = version;
			entry.resolved = specifier(name);
			entry.integrity = artifact.integrity;
		}
		for (const section of DEPENDENCY_SECTIONS) {
			for (const dependency of Object.keys(entry[section] ?? {})) {
				if (isInternal(dependency)) entry[section][dependency] = version;
			}
		}
	}
	nextLock.version = version;
	return { packageJson: nextPackageJson, lock: nextLock };
}

export function prepareImageContext({ manifestPath, outDir, repoRoot }) {
	const artifactSet = readArtifactSet(manifestPath);
	const installLockDir = join(repoRoot, "packages/coding-agent/install-lock");
	const installDir = join(outDir, "install");
	if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
	mkdirSync(join(installDir, "tarballs"), { recursive: true });
	const artifacts = artifactSet.packages.map((pkg) => {
		const file = `tarballs/${pkg.name.split("/").pop()}.tgz`;
		copyFileSync(pkg.tarballPath, join(installDir, file));
		return { name: pkg.name, version: pkg.version, file, integrity: pkg.integrity };
	});
	const { packageJson, lock } = buildInstallLock({
		packageJson: JSON.parse(readFileSync(join(installLockDir, "package.json"), "utf8")),
		lock: JSON.parse(readFileSync(join(installLockDir, "package-lock.json"), "utf8")),
		artifacts,
	});
	writeFileSync(join(installDir, "package.json"), `${JSON.stringify(packageJson, null, "\t")}\n`);
	writeFileSync(join(installDir, "package-lock.json"), `${JSON.stringify(lock, null, "\t")}\n`);
	return { installDir, version: artifacts[0].version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({ options: { manifest: { type: "string" }, out: { type: "string" } } });
	if (!values.manifest || !values.out) {
		console.error("Usage: image-install-root.mjs --manifest <artifact manifest.json> --out <dir>");
		process.exit(2);
	}
	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const { installDir, version } = prepareImageContext({ manifestPath: values.manifest, outDir: resolve(values.out), repoRoot });
	console.log(`Image context for Fingers ${version}: ${installDir}`);
}
