#!/usr/bin/env node
/**
 * Runs the Fingers ee tests (ee/test, with ee/vitest.config.ts). A core-only checkout without ee/ has none: it says
 * so and exits 0. Extra arguments go to vitest (e.g. --maxWorkers=1).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = join(repoRoot, "ee", "vitest.config.ts");
if (!existsSync(config)) {
	console.log("no ee/ folder: core only, no ee tests to run");
	process.exit(0);
}
const vitestPackage = createRequire(import.meta.url).resolve("vitest/package.json");
const vitest = join(dirname(vitestPackage), "vitest.mjs");
const result = spawnSync(process.execPath, [vitest, "--run", "--config", config, ...process.argv.slice(2)], {
	cwd: join(repoRoot, "ee"),
	stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
