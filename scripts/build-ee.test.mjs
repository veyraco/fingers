// Building Fingers ee into the coding agent's dist/ee/: index.js with ee/LICENSE next to it; nothing (and no stale
// dist/ee/) without the ee/ folder; and no runtime import of a Fingers package from ee code.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildEe } from "./build-ee.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const temps = [];

function tree(files) {
	const root = mkdtempSync(join(tmpdir(), "fingers-build-ee-"));
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

describe("build-ee", () => {
	it("builds ee/src/index.ts into dist/ee/index.js with ee/LICENSE beside it", async () => {
		const root = tree({
			"ee/LICENSE": "The Veyra Fingers Enterprise License\n",
			"ee/src/index.ts":
				'import type { EeHost } from "@veyraco/fingers";\nimport { tier } from "./matrix.ts";\nexport const apiVersion = 1;\nexport function activate(host: EeHost): void { void host; }\nexport const t = tier;\n',
			"ee/src/matrix.ts": 'export const tier: string = "low";\n',
		});
		const outDir = join(root, "out", "ee");
		const result = await buildEe({ root, outDir });
		assert.equal(result.built, true);
		assert.equal(readFileSync(join(outDir, "LICENSE"), "utf8"), "The Veyra Fingers Enterprise License\n");
		const output = readFileSync(join(outDir, "index.js"), "utf8");
		assert.match(output, /^\/\/ Fingers ee\. .*not MIT\./);
		assert.doesNotMatch(output, /@veyraco\//);
		const loaded = await import(pathToFileURL(join(outDir, "index.js")).href);
		assert.equal(loaded.t, "low");
	});

	it("builds nothing and removes an old dist/ee/ when there is no ee/ folder", async () => {
		const root = tree({ "out/ee/index.js": "export const stale = true;\n", "out/ee/LICENSE": "old\n" });
		const outDir = join(root, "out", "ee");
		assert.deepEqual(await buildEe({ root, outDir }), { built: false });
		assert.equal(existsSync(outDir), false);
	});

	it("fails when ee code imports a Fingers package at run time", async () => {
		const root = tree({
			"ee/LICENSE": "ee\n",
			"ee/src/index.ts": 'import { VERSION } from "@veyraco/fingers";\nexport const v = VERSION;\n',
		});
		const outDir = join(root, "out", "ee");
		await assert.rejects(buildEe({ root, outDir }), /ee\/ imports @veyraco\/fingers at run time/);
		assert.equal(existsSync(outDir), false);
	});

	it("builds this repository's ee/ when it is there", async () => {
		if (!existsSync(join(repoRoot, "ee", "src", "index.ts"))) return;
		const outDir = join(tree({}), "ee");
		assert.equal((await buildEe({ root: repoRoot, outDir })).built, true);
		const loaded = await import(pathToFileURL(join(outDir, "index.js")).href);
		// The core's EE_API_VERSION (7 since sub-agent engines, F18).
		assert.equal(loaded.apiVersion, 7);
		assert.equal(typeof loaded.default.activate, "function");
	});
});
