#!/usr/bin/env node
// Usage: node scripts/publish.mjs [--dry-run] [--manifest <artifact manifest.json>]
//
// With --manifest it publishes that already-packed artifact set: the release workflow packs once
// and checks, images and publishes the same tarballs. Without it, it packs the built workspace.
// Every tarball passes scripts/check-package-tarballs.mjs first. Stable versions go to the
// `latest` dist-tag, prereleases to `next`. Versions already on npm are skipped, so a failed
// release can be re-run.

import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkArtifactSet } from "./check-package-tarballs.mjs";
import { execNpmSync } from "./npm-command.mjs";
import { produceArtifactSet, readArtifactSet } from "./package-artifacts.mjs";
import { distTagFor } from "./release-check.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const { values: options } = parseArgs({
	options: { "dry-run": { type: "boolean", default: false }, manifest: { type: "string" } },
});
const dryRun = options["dry-run"];

function isPublished(name, version) {
	try {
		const output = execNpmSync(["view", `${name}@${version}`, "version", "--json"], {
			encoding: "utf8",
			stdio: ["inherit", "pipe", "pipe"],
		});
		if (!output.trim()) throw new Error(`npm returned no version for ${name}@${version}`);
		return true;
	} catch (error) {
		const output = error && typeof error === "object"
			? ["stdout", "stderr"].map((key) => key in error ? String(error[key] ?? "") : "").filter(Boolean).join("\n")
			: "";
		if (output.includes("E404") || output.includes("404 Not Found")) return false;
		throw new Error(`Failed to query ${name}@${version}${output ? `\n${output}` : ""}`, { cause: error });
	}
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let artifactSet;
if (options.manifest) {
	artifactSet = readArtifactSet(options.manifest);
} else {
	for (const pkg of getPublicWorkspacePackages(join(repoRoot, "packages"))) {
		if (!existsSync(join(pkg.directory, "dist"))) {
			throw new Error(`${pkg.directory}/dist does not exist. Run npm run build before publishing.`);
		}
	}
	artifactSet = produceArtifactSet({ build: false, repoRoot });
}

try {
	const versions = [...new Set(artifactSet.packages.map((pkg) => pkg.version))];
	if (versions.length !== 1) throw new Error(`Publish packages are not lockstep versioned: ${versions.join(", ")}`);
	const problems = checkArtifactSet(artifactSet.manifestPath, repoRoot);
	if (problems.length > 0) throw new Error(`Package tarballs are not ready to publish:\n  ${problems.join("\n  ")}`);
	const distTag = distTagFor(versions[0]);
	console.log(`Publishing fingers packages at ${versions[0]} under the ${distTag} dist-tag${dryRun ? " (dry run)" : ""}\n`);

	const packageStates = artifactSet.packages.map((pkg) => ({ ...pkg, published: isPublished(pkg.name, pkg.version) }));
	for (const pkg of packageStates) {
		console.log(`${pkg.name}@${pkg.version} ${pkg.published ? "is already published" : "is ready to publish"}: ${pkg.tarballPath}`);
	}
	console.log(dryRun ? "\nDry-running tarball publication with provenance.\n" : "\nAll packages packed; starting publication.\n");
	for (const pkg of packageStates) {
		if (pkg.published) {
			console.log(`Skipping ${pkg.name}@${pkg.version}: already published\n`);
			continue;
		}
		const args = ["publish", pkg.tarballPath, "--access", "public", "--tag", distTag, "--provenance", "--ignore-scripts"];
		if (dryRun) args.push("--dry-run");
		// Outside the workspace, so npm does not read the workspace's package.json or .npmrc.
		execNpmSync(args, { cwd: artifactSet.artifactDirectory, stdio: "inherit" });
		console.log();
	}
} finally {
	// A caller's artifact set stays: the release workflow also builds the image from it.
	if (!options.manifest) rmSync(artifactSet.artifactDirectory, { force: true, recursive: true });
}
