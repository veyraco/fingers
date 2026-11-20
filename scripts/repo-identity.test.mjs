// Guards the identity of the Veyra Fingers repository: the upstream MIT notice
// stays in LICENSE, the workspace holds only the packages Fingers ships, and
// the old upstream names do not come back.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

// Pi's MIT notice, kept verbatim. The MIT license requires it in every copy.
const UPSTREAM_NOTICE = `Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const EXPECTED_PACKAGES = {
	"packages/agent": "@veyraco/fingers-agent",
	"packages/ai": "@veyraco/fingers-ai",
	"packages/codemode": "@veyraco/fingers-codemode",
	"packages/coding-agent": "@veyraco/fingers",
	"packages/evals": "@veyraco/fingers-evals",
	"packages/mcp": "@veyraco/fingers-mcp",
	"packages/schema": "@veyraco/fingers-schema",
	"packages/telemetry": "@veyraco/fingers-telemetry",
	"packages/tui": "@veyraco/fingers-tui",
};

// Upstream names that must not appear anywhere but LICENSE.
const FORBIDDEN = [/@earendil-works\//, /earendil-works\/pi\b/, /\bbadlogic\b/, /\bpi-mono\b/, /\bmariozechner\b/, /Mario Zechner/];

// LICENSE and this test hold the upstream notice; third-party material keeps its own text.
const SCAN_SKIP = new Set([
	".git",
	"node_modules",
	"dist",
	"LICENSE",
	"repo-identity.test.mjs",
	"THIRD_PARTY_NOTICES",
	"json-schema-test-suite",
]);
const BINARY = /\.(png|gif|jpe?g|webp|ico|wasm|node|woff2?)$/i;

function* textFiles(dir) {
	for (const entry of readdirSync(dir)) {
		if (SCAN_SKIP.has(entry)) continue;
		const path = join(dir, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) yield* textFiles(path);
		else if (!BINARY.test(entry)) yield path;
	}
}

describe("repository identity", () => {
	it("keeps Pi's MIT notice verbatim in LICENSE", () => {
		const license = readFileSync(join(root, "LICENSE"), "utf8");
		assert.match(license, /^MIT License\n/);
		assert.ok(license.includes(UPSTREAM_NOTICE), "LICENSE must hold the upstream MIT notice unchanged");
	});

	it("names every workspace package as a Veyra Fingers package", () => {
		const found = {};
		for (const dir of readdirSync(join(root, "packages"))) {
			const manifest = join(root, "packages", dir, "package.json");
			if (existsSync(manifest)) found[`packages/${dir}`] = readJson(`packages/${dir}/package.json`).name;
		}
		assert.deepEqual(found, EXPECTED_PACKAGES);
		assert.equal(existsSync(join(root, "apps")), false, "apps/* are not part of Fingers");
	});

	it("ships the fingers binary with its own config directory", () => {
		const cli = readJson("packages/coding-agent/package.json");
		assert.deepEqual(Object.keys(cli.bin), ["fingers"]);
		assert.deepEqual(cli.fingersConfig, { name: "fingers", configDir: ".fingers" });
		assert.deepEqual(Object.keys(readJson("packages/ai/package.json").bin), ["fingers-ai"]);
	});

	it("locks no dropped or upstream package", () => {
		const lock = readJson("package-lock.json");
		const paths = Object.keys(lock.packages);
		const dropped = paths.filter((p) => /^(apps\/|packages\/(chord|durable|env)(\/|$))/.test(p));
		assert.deepEqual(dropped, []);
		const upstream = paths.filter((p) => p.includes("@earendil-works"));
		assert.deepEqual(upstream, []);
		for (const [dir, name] of Object.entries(EXPECTED_PACKAGES)) {
			assert.equal(lock.packages[`node_modules/${name}`]?.link, true, `${name} must link to ${dir}`);
			assert.equal(lock.packages[`node_modules/${name}`]?.resolved, dir);
		}
	});

	it("keeps upstream names out of every file but LICENSE", () => {
		const hits = [];
		for (const file of textFiles(root)) {
			const text = readFileSync(file, "utf8");
			for (const pattern of FORBIDDEN) {
				if (pattern.test(text)) hits.push(`${relative(root, file)}: ${pattern}`);
			}
		}
		assert.deepEqual(hits, []);
	});
});
