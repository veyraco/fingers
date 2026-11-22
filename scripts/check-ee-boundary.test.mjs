// The open-core boundary check: a core file that imports ee/ fails it; ee/ importing the core, and the core's
// run-time lookup of the built ee module, pass.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { findEeImports, importSpecifiers, pointsIntoEe } from "./check-ee-boundary.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "check-ee-boundary.mjs");
const temps = [];

function repo(files) {
	const root = mkdtempSync(join(tmpdir(), "fingers-ee-boundary-"));
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

const CORE = "packages/coding-agent/src/core/x.ts";

describe("ee boundary check", () => {
	it("passes the repository as it is", () => {
		assert.deepEqual(findEeImports(repoRoot), []);
	});

	for (const [name, line] of [
		["a static import", 'import { activate } from "../../../../ee/src/index.ts";'],
		["a type-only import", 'import type { EeModule } from "../../../../ee/src/index.ts";'],
		["an export-from", 'export * from "../../../../ee/src/tier-matrix.ts";'],
		["a side-effect import", 'import "../../../../ee/src/index.ts";'],
		["a dynamic import", 'const ee = await import("../../../../ee/src/index.ts");'],
		["a require", 'const ee = require("../../../../ee/src/index.ts");'],
		["an ee package", 'import ee from "@veyraco/fingers-ee";'],
		["an ee package subpath", 'import { x } from "@veyraco/fingers-ee/matrix";'],
		["a multi-line import", 'import {\n\tactivate,\n\tminimumTier,\n} from "../../../../ee/src/index.ts";'],
	]) {
		it(`fails a core file with ${name}`, () => {
			const root = repo({ [CORE]: `${line}\n`, "ee/src/index.ts": "export const apiVersion = 1;\n" });
			const violations = findEeImports(root);
			assert.equal(violations.length, 1, violations.join("\n"));
			assert.match(violations[0], /^packages\/coding-agent\/src\/core\/x\.ts:1 imports /);
		});
	}

	it("exits 1 and names the file when the core imports ee/", () => {
		const root = repo({
			[CORE]: 'import { activate } from "../../../../ee/src/index.ts";\n',
			"ee/src/index.ts": "export function activate() {}\n",
		});
		const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /packages\/coding-agent\/src\/core\/x\.ts:1 imports \.\.\/\.\.\/\.\.\/\.\.\/ee\/src\/index\.ts/);
	});

	it("lets ee/ import the core, and the core look up the built module by path at run time", () => {
		const root = repo({
			"ee/src/index.ts": 'import type { EeHost } from "@veyraco/fingers";\nimport { x } from "../../packages/coding-agent/src/core/x.ts";\n',
			[CORE]: 'const file = join(packageDir, "dist", "ee", "index.js");\nawait import(pathToFileURL(file).href);\n',
			"packages/coding-agent/src/core/eel.ts": 'import { a } from "./ee-like.ts";\nimport { b } from "./feel.ts";\n',
		});
		const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(findEeImports(root), []);
	});

	it("does not treat a folder that only starts with ee as ee/", () => {
		assert.equal(pointsIntoEe("../eel/x.ts", "/r/scripts/a.mjs", "/r"), false);
		assert.equal(pointsIntoEe("../ee/x.ts", "/r/scripts/a.mjs", "/r"), true);
		assert.equal(pointsIntoEe("/r/ee", "/r/scripts/a.mjs", "/r"), true);
		assert.equal(pointsIntoEe("file:///r/ee/src/index.ts", "/r/scripts/a.mjs", "/r"), true);
		assert.equal(pointsIntoEe("@veyraco/fingers", "/r/scripts/a.mjs", "/r"), false);
	});

	it("reads specifiers with their line numbers", () => {
		assert.deepEqual(importSpecifiers('import a from "a";\n\nexport { b } from "b";\n'), [
			{ specifier: "a", line: 1 },
			{ specifier: "b", line: 3 },
		]);
	});
});
