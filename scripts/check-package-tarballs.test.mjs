// What a published Fingers tarball may hold (scripts/check-package-tarballs.mjs): the license
// next to the code (and ee/LICENSE next to any ee/ code), no tests, no source maps, no local
// secrets or session files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { listPackFiles, tarballViolations } from "./check-package-tarballs.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootLicense = readFileSync(join(root, "LICENSE"), "utf8");

function check(files, extra = {}) {
	return tarballViolations({ name: "@veyraco/x", files, license: rootLicense, rootLicense, ...extra });
}

describe("tarballViolations", () => {
	it("accepts a package with its license, code, docs and examples", () => {
		assert.deepEqual(check(["package.json", "LICENSE", "README.md", "dist/index.js", "dist/index.d.ts", "docs/a.md", "examples/x/index.ts"]), []);
	});

	it("requires LICENSE at the package root", () => {
		assert.deepEqual(check(["package.json", "dist/index.js"], { license: undefined }), ["@veyraco/x: LICENSE is missing"]);
	});

	it("requires the LICENSE text to be the repository's", () => {
		assert.deepEqual(check(["package.json", "LICENSE"], { license: "MIT License\n\nCopyright (c) someone else\n" }), [
			"@veyraco/x: LICENSE differs from the repository LICENSE",
		]);
	});

	it("refuses source maps", () => {
		assert.deepEqual(check(["package.json", "LICENSE", "dist/index.js", "dist/index.js.map", "dist/index.d.ts.map"]), [
			"@veyraco/x: source map dist/index.js.map",
			"@veyraco/x: source map dist/index.d.ts.map",
		]);
	});

	it("refuses tests and test folders", () => {
		assert.deepEqual(
			check(["package.json", "LICENSE", "dist/a.test.js", "dist/b.spec.ts", "test/c.ts", "dist/__tests__/d.js", "tests/e.ts"]),
			[
				"@veyraco/x: test file dist/a.test.js",
				"@veyraco/x: test file dist/b.spec.ts",
				"@veyraco/x: test file test/c.ts",
				"@veyraco/x: test file dist/__tests__/d.js",
				"@veyraco/x: test file tests/e.ts",
			],
		);
	});

	it("keeps files whose names only contain the word test", () => {
		assert.deepEqual(check(["package.json", "LICENSE", "dist/latest-version.js", "dist/contest.js", "docs/testing.md"]), []);
	});

	it("refuses local secrets, sessions and logs", () => {
		assert.deepEqual(check(["package.json", "LICENSE", ".env", "dist/.env.local", ".npmrc", "auth.json", "x.jsonl", "debug.log"]), [
			"@veyraco/x: local file .env",
			"@veyraco/x: local file dist/.env.local",
			"@veyraco/x: local file .npmrc",
			"@veyraco/x: local file auth.json",
			"@veyraco/x: local file x.jsonl",
			"@veyraco/x: local file debug.log",
		]);
	});

	it("requires ee/LICENSE wherever ee/ code ships", () => {
		assert.deepEqual(check(["package.json", "LICENSE", "dist/ee/savings.js"]), ["@veyraco/x: dist/ee/ ships without dist/ee/LICENSE"]);
		assert.deepEqual(check(["package.json", "LICENSE", "dist/ee/savings.js", "dist/ee/LICENSE"]), []);
		assert.deepEqual(check(["package.json", "LICENSE", "ee/a.js", "ee/LICENSE"]), []);
	});
});

describe("the public packages as npm would pack them", () => {
	// Needs a build (dist/); CI runs `npm run build` before the script tests.
	for (const pkg of getPublicWorkspacePackages(join(root, "packages"))) {
		it(`${pkg.name} packs with its license and without maps or tests`, () => {
			const files = listPackFiles(pkg.directory);
			let license;
			try {
				license = readFileSync(join(pkg.directory, "LICENSE"), "utf8");
			} catch {}
			assert.deepEqual(tarballViolations({ name: pkg.name, files, license, rootLicense }), []);
		});
	}
});
