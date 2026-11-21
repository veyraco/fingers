// Release gate (scripts/release-check.mjs): a tag releases only the versions the packages
// already say, prereleases go to the `next` dist-tag, and main's prerelease versions sort
// after everything already published.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { distTagFor, nextPrereleaseVersion, parseReleaseTag, releaseProblems } from "./release-check.mjs";

const changelog = "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-11-21\n\n### Added\n\n- x\n";

function pkgs(version, overrides = {}) {
	return [
		{ name: "@veyraco/fingers-ai", version, dependencies: { "@veyraco/fingers-schema": version, undici: "7.0.0" } },
		{ name: "@veyraco/fingers-schema", version },
		{ name: "@veyraco/fingers", version, dependencies: { "@veyraco/fingers-ai": version }, ...overrides },
	];
}

describe("parseReleaseTag", () => {
	it("reads stable and prerelease tags", () => {
		assert.deepEqual(parseReleaseTag("v0.2.0"), { version: "0.2.0", prerelease: false });
		assert.deepEqual(parseReleaseTag("v0.2.1-next.7"), { version: "0.2.1-next.7", prerelease: true });
	});

	it("refuses anything else", () => {
		for (const tag of ["0.2.0", "v0.2", "v0.2.0.1", "v0.2.0-", "v0.2.0-next.7;rm", "go/v0.2.0", "v01.2.0"]) {
			assert.throws(() => parseReleaseTag(tag), /not a release tag/, tag);
		}
	});
});

describe("releaseProblems", () => {
	it("accepts lockstep packages at the tag's version with a changelog section", () => {
		assert.deepEqual(releaseProblems({ tag: "v0.2.0", packages: pkgs("0.2.0"), changelog }), []);
	});

	it("refuses a tag the packages do not say", () => {
		assert.deepEqual(releaseProblems({ tag: "v0.3.0", packages: pkgs("0.2.0"), changelog: `${changelog}\n## [0.3.0] - x\n` }), [
			"@veyraco/fingers-ai is 0.2.0, the tag says 0.3.0",
			"@veyraco/fingers-schema is 0.2.0, the tag says 0.3.0",
			"@veyraco/fingers is 0.2.0, the tag says 0.3.0",
			"@veyraco/fingers-ai depends on @veyraco/fingers-schema 0.2.0, not 0.3.0",
			"@veyraco/fingers depends on @veyraco/fingers-ai 0.2.0, not 0.3.0",
		]);
	});

	it("refuses an internal dependency that is not pinned to the release", () => {
		const packages = pkgs("0.2.0", { dependencies: { "@veyraco/fingers-ai": "^0.1.0" } });
		assert.deepEqual(releaseProblems({ tag: "v0.2.0", packages, changelog }), [
			"@veyraco/fingers depends on @veyraco/fingers-ai ^0.1.0, not 0.2.0",
		]);
	});

	it("needs a changelog section for a stable release, not for a prerelease", () => {
		assert.deepEqual(releaseProblems({ tag: "v0.2.0", packages: pkgs("0.2.0"), changelog: "# Changelog\n\n## [Unreleased]\n" }), [
			"packages/coding-agent/CHANGELOG.md has no ## [0.2.0] section",
		]);
		assert.deepEqual(releaseProblems({ tag: "v0.2.1-next.3", packages: pkgs("0.2.1-next.3"), changelog }), []);
	});
});

describe("distTagFor", () => {
	it("publishes stable versions as latest and prereleases as next", () => {
		assert.equal(distTagFor("0.2.0"), "latest");
		assert.equal(distTagFor("0.2.1-next.4"), "next");
	});
});

describe("nextPrereleaseVersion", () => {
	it("uses the package version while it is unpublished", () => {
		assert.equal(nextPrereleaseVersion({ current: "0.1.0", published: false, run: 12 }), "0.1.0-next.12");
	});

	it("moves past a published version so next sorts above latest", () => {
		assert.equal(nextPrereleaseVersion({ current: "0.1.0", published: true, run: 13 }), "0.1.1-next.13");
	});

	it("refuses a run number that is not a positive integer", () => {
		assert.throws(() => nextPrereleaseVersion({ current: "0.1.0", published: false, run: "1;x" }), /run number/);
		assert.throws(() => nextPrereleaseVersion({ current: "0.1.0-next.1", published: false, run: 1 }), /stable version/);
	});
});
