// The ghcr.io/veyraco/fingers image installs Fingers from the release's own tarballs with the
// coding-agent install lock (scripts/image-install-root.mjs, docker/fingers/Dockerfile): the
// Fingers packages come from the tarballs CI just built and checked, every other dependency at
// the locked version and integrity. Nothing in the image depends on the npm publish having run.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { buildInstallLock, prepareImageContext } from "./image-install-root.mjs";
import { produceArtifactSet } from "./package-artifacts.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fixtureLock() {
	return {
		packageJson: {
			name: "@veyraco/fingers-install",
			version: "0.1.0",
			private: true,
			dependencies: { "@veyraco/fingers": "0.1.0" },
			overrides: { protobufjs: "7.6.6" },
		},
		lock: {
			name: "@veyraco/fingers-install",
			version: "0.1.0",
			lockfileVersion: 3,
			requires: true,
			packages: {
				"": { name: "@veyraco/fingers-install", version: "0.1.0", dependencies: { "@veyraco/fingers": "0.1.0" } },
				"node_modules/@veyraco/fingers": {
					version: "0.1.0",
					resolved: "https://registry.npmjs.org/@veyraco/fingers/-/fingers-0.1.0.tgz",
					license: "MIT",
					dependencies: { "@veyraco/fingers-ai": "0.1.0", chalk: "5.6.2" },
					bin: { fingers: "dist/cli.js" },
				},
				"node_modules/@veyraco/fingers-ai": {
					version: "0.1.0",
					resolved: "https://registry.npmjs.org/@veyraco/fingers-ai/-/fingers-ai-0.1.0.tgz",
					license: "MIT",
				},
				"node_modules/@veyraco/fingers-ai/node_modules/agent-base": {
					version: "9.0.0",
					resolved: "https://registry.npmjs.org/agent-base/-/agent-base-9.0.0.tgz",
					integrity: "sha512-abc",
				},
				"node_modules/chalk": { version: "5.6.2", resolved: "https://registry.npmjs.org/chalk/-/chalk-5.6.2.tgz", integrity: "sha512-def" },
			},
		},
	};
}

const artifacts = [
	{ name: "@veyraco/fingers", version: "0.1.1-next.4", file: "tarballs/fingers.tgz", integrity: "sha512-AAA" },
	{ name: "@veyraco/fingers-ai", version: "0.1.1-next.4", file: "tarballs/fingers-ai.tgz", integrity: "sha512-BBB" },
];

describe("buildInstallLock", () => {
	it("resolves the Fingers packages to the local tarballs at the release version", () => {
		const { packageJson, lock } = buildInstallLock({ ...fixtureLock(), artifacts });
		assert.deepEqual(packageJson.dependencies, { "@veyraco/fingers": "file:tarballs/fingers.tgz" });
		assert.equal(packageJson.overrides.protobufjs, "7.6.6");
		assert.equal(packageJson.overrides["@veyraco/fingers-ai"], "file:tarballs/fingers-ai.tgz");
		assert.deepEqual(lock.packages[""].dependencies, { "@veyraco/fingers": "file:tarballs/fingers.tgz" });
		const fingers = lock.packages["node_modules/@veyraco/fingers"];
		assert.equal(fingers.version, "0.1.1-next.4");
		assert.equal(fingers.resolved, "file:tarballs/fingers.tgz");
		assert.equal(fingers.integrity, "sha512-AAA");
		assert.deepEqual(fingers.dependencies, { "@veyraco/fingers-ai": "0.1.1-next.4", chalk: "5.6.2" });
		assert.equal(lock.packages["node_modules/@veyraco/fingers-ai"].resolved, "file:tarballs/fingers-ai.tgz");
	});

	it("leaves every other dependency at its locked version and integrity", () => {
		const input = fixtureLock();
		const { lock } = buildInstallLock({ ...input, artifacts });
		assert.deepEqual(lock.packages["node_modules/chalk"], input.lock.packages["node_modules/chalk"]);
		assert.deepEqual(
			lock.packages["node_modules/@veyraco/fingers-ai/node_modules/agent-base"],
			input.lock.packages["node_modules/@veyraco/fingers-ai/node_modules/agent-base"],
		);
	});

	it("refuses a locked Fingers package the release did not build", () => {
		assert.throws(() => buildInstallLock({ ...fixtureLock(), artifacts: artifacts.slice(0, 1) }), /@veyraco\/fingers-ai is in the install lock but not in the release/);
	});

	it("refuses a release whose versions are not lockstep", () => {
		const mixed = [artifacts[0], { ...artifacts[1], version: "0.1.0" }];
		assert.throws(() => buildInstallLock({ ...fixtureLock(), artifacts: mixed }), /lockstep/);
	});
});

describe("docker/fingers/Dockerfile", () => {
	const dockerfile = readFileSync(join(root, "docker/fingers/Dockerfile"), "utf8");
	const instructions = dockerfile.split("\n").filter((line) => line.trim() && !line.trim().startsWith("#"));

	it("pins every base image by digest", () => {
		const froms = instructions.filter((line) => /^FROM\s/i.test(line));
		assert.ok(froms.length > 0);
		for (const from of froms) assert.match(from, /^FROM\s+\S+@sha256:[0-9a-f]{64}(\s+AS\s+\S+)?\s*$/i, from);
	});

	it("installs from the lock without install scripts or a registry Fingers", () => {
		assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
		assert.doesNotMatch(dockerfile, /npm (install|i) (-g )?@veyraco/);
		assert.doesNotMatch(dockerfile, /curl[^\n]*\|\s*(ba)?sh/);
	});

	it("ships git, ripgrep and fd so Fingers never downloads tools at start", () => {
		for (const tool of ["git", "ripgrep", "fd-find"]) assert.match(dockerfile, new RegExp(`\\b${tool}\\b`));
	});

	it("runs as uid 1000 in /workspace with fingers as the entrypoint", () => {
		assert.match(dockerfile, /^USER 1000:1000$/m);
		assert.match(dockerfile, /^WORKDIR \/workspace$/m);
		assert.match(dockerfile, /^ENTRYPOINT \["\/usr\/bin\/tini", "--", "fingers"\]$/m);
	});
});

describe("prepareImageContext with the real packages", { skip: process.env.FINGERS_IMAGE_INSTALL_E2E !== "1" && "set FINGERS_IMAGE_INSTALL_E2E=1 (packs every package and installs from npm)" }, () => {
	it("installs a working fingers from the release tarballs", () => {
		const work = mkdtempSync(join(tmpdir(), "fingers-image-context-"));
		try {
			const artifactSet = produceArtifactSet({ build: false, outDir: join(work, "artifacts"), repoRoot: root });
			const context = join(work, "context");
			prepareImageContext({ manifestPath: artifactSet.manifestPath, outDir: context, repoRoot: root });
			assert.ok(existsSync(join(context, "install", "package-lock.json")));
			execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: join(context, "install"), stdio: "inherit" });
			const version = execFileSync(join(context, "install", "node_modules", ".bin", "fingers"), ["--version"], {
				encoding: "utf8",
				env: { ...process.env, HOME: work, FINGERS_SKIP_VERSION_CHECK: "1" },
			}).trim();
			assert.equal(version, artifactSet.getPackage("@veyraco/fingers").version);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});
});
