// The Markdown link check: a relative link or image to a missing file, or a #fragment that names no heading of the
// target page, fails it; links to this repository on GitHub are checked like relative ones; code, other web
// addresses and changelogs are not checked. The repository's own Markdown passes it, with ee/ and without it (the
// open-core CI job deletes ee/), and links into ee/ are still checked while ee/ exists.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { anchorsOf, findBrokenLinks, headingSlug } from "./check-doc-links.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "check-doc-links.mjs");
const temps = [];

function repo(files) {
	const root = mkdtempSync(join(tmpdir(), "fingers-doc-links-"));
	temps.push(root);
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return root;
}

afterEach(() => {
	for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("headingSlug", () => {
	it("derives GitHub's anchors", () => {
		assert.equal(headingSlug("Open core"), "open-core");
		assert.equal(headingSlug("fingers.registerProvider(name, config)"), "fingersregisterprovidername-config");
		assert.equal(headingSlug("`/agents` and the **panel**"), "agents-and-the-panel");
		assert.equal(headingSlug("Use [Brain](https://veyra.so/brain) memory"), "use-brain-memory");
		assert.equal(headingSlug("snake_case names"), "snake_case-names");
		assert.equal(headingSlug("Résumé — étapes"), "résumé--étapes");
	});

	it("numbers repeated headings and keeps explicit anchors; headings in code blocks do not count", () => {
		const anchors = anchorsOf("# A\n## Usage\n## Usage\n<a id=\"modes\"></a>\n```md\n## Not a heading\n```\n");
		assert.deepEqual([...anchors].sort(), ["a", "modes", "usage", "usage-1"]);
	});
});

describe("findBrokenLinks", () => {
	it("passes links to files, folders and headings that exist", () => {
		const root = repo({
			"README.md": "[docs](docs/index.md#start-here) [folder](docs) ![banner](.github/banner.png#gh-dark-mode-only) [top](#readme) <a href=\"LICENSE\">l</a>\n# Readme\n",
			"LICENSE": "MIT\n",
			".github/banner.png": "png",
			"docs/index.md": "# Start here\n[back](../README.md) [web](https://example.com/missing) [mail](mailto:a@b.c)\n",
		});
		assert.deepEqual(findBrokenLinks(root), []);
	});

	it("reports a missing file, a missing heading and a link on GitHub to a missing path", () => {
		const root = repo({
			"README.md": [
				"# Readme",
				"[gone](docs/gone.md)",
				"[anchor](docs/index.md#no-such-heading)",
				"[self](#nowhere)",
				"[gh](https://github.com/veyraco/fingers/blob/main/ee/LICENSE)",
				"[gh anchor](https://github.com/veyraco/fingers/blob/main/docs/index.md#intro)",
				"<img src=\"missing.png\">",
			].join("\n"),
			"docs/index.md": "# Index\n",
			"ee/README.md": "# Enterprise\n",
		});
		assert.deepEqual(findBrokenLinks(root), [
			"README.md:2: docs/gone.md: docs/gone.md does not exist",
			"README.md:3: docs/index.md#no-such-heading: no heading or anchor #no-such-heading in docs/index.md",
			"README.md:4: #nowhere: no heading or anchor #nowhere in README.md",
			"README.md:5: https://github.com/veyraco/fingers/blob/main/ee/LICENSE: ee/LICENSE does not exist",
			"README.md:6: https://github.com/veyraco/fingers/blob/main/docs/index.md#intro: no heading or anchor #intro in docs/index.md",
			"README.md:7: missing.png: missing.png does not exist",
		]);
	});

	it("accepts links into ee/ when the ee/ folder is deleted, and still reports other broken links", () => {
		const links = [
			"# Readme",
			"[license](ee/LICENSE)",
			"[ee](ee/README.md#enterprise)",
			"[ee folder](ee)",
			"[gh](https://github.com/veyraco/fingers/blob/main/ee/LICENSE)",
			"[gh tree](https://github.com/veyraco/fingers/tree/main/ee/src)",
			"[gone](docs/gone.md)",
		].join("\n");
		const root = repo({ "README.md": links, "docs/open-core.md": "# Open core\n[up](../ee/README.md)\n" });
		assert.deepEqual(findBrokenLinks(root), ["README.md:7: docs/gone.md: docs/gone.md does not exist"]);
	});

	it("checks Markdown under .github but not other dot folders", () => {
		const root = repo({
			"README.md": "# R\n",
			".github/PULL_REQUEST_TEMPLATE.md": "[guide](../CONTRIBUTING.md)\n",
			".husky/notes.md": "[x](gone.md)\n",
		});
		assert.deepEqual(findBrokenLinks(root), [
			".github/PULL_REQUEST_TEMPLATE.md:1: ../CONTRIBUTING.md: CONTRIBUTING.md does not exist",
		]);
	});

	it("skips code blocks, inline code, changelogs and node_modules", () => {
		const root = repo({
			"README.md": "# R\n`[x](gone.md)`\n```md\n[y](gone.md)\n```\n",
			"CHANGELOG.md": "[old](removed.md)\n",
			"node_modules/pkg/README.md": "[z](gone.md)\n",
		});
		assert.deepEqual(findBrokenLinks(root), []);
	});

	it("passes on this repository, and the command exits 1 on a broken link", () => {
		assert.deepEqual(findBrokenLinks(repoRoot), []);
		const withoutEe = repo({ "README.md": "# R\n[license](ee/LICENSE)\n" });
		const ok = spawnSync(process.execPath, [script, withoutEe], { encoding: "utf8" });
		assert.equal(ok.status, 0, ok.stderr);
		assert.match(ok.stdout, /Markdown links OK/);
		const root = repo({ "README.md": "[gone](gone.md)\n" });
		const run = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
		assert.equal(run.status, 1);
		assert.match(run.stderr, /README\.md:1: gone\.md: gone\.md does not exist/);
	});
});
