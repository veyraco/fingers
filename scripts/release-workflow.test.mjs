// Static rules for the release workflow (.github/workflows/release.yml): third-party actions
// pinned by commit, each job holds only the permissions and secrets it needs, no event text in a
// shell, nothing is pushed before the smoke test, and main publishes only when switched on.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const text = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
const workflow = parse(text);
const jobs = workflow.jobs;
const steps = (job) => jobs[job].steps;

describe("release workflow", () => {
	it("pins every action by a full commit sha", () => {
		for (const [name, job] of Object.entries(jobs)) {
			for (const step of job.steps) {
				if (step.uses) assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${name}: ${step.uses}`);
			}
		}
	});

	it("grants nothing by default and each job only what it needs", () => {
		assert.deepEqual(workflow.permissions, {});
		assert.deepEqual(jobs.prepare.permissions, { contents: "read" });
		assert.deepEqual(jobs.npm.permissions, { contents: "read", "id-token": "write" });
		assert.deepEqual(jobs.image.permissions, { contents: "read", packages: "write" });
		assert.deepEqual(jobs.binaries.permissions, { contents: "read" });
		assert.deepEqual(jobs["github-release"].permissions, { contents: "write" });
	});

	it("hands the npm token only to the npm publish step", () => {
		for (const [name, job] of Object.entries(jobs)) {
			for (const step of job.steps) {
				const usesToken = JSON.stringify(step).includes("secrets.NPM_TOKEN");
				assert.equal(usesToken, name === "npm" && step.name === "Publish", `${name}/${step.name}`);
			}
		}
	});

	it("puts no event text into a shell", () => {
		for (const [name, job] of Object.entries(jobs)) {
			for (const step of job.steps) {
				if (step.run) assert.doesNotMatch(step.run, /\$\{\{/, `${name}/${step.name} interpolates an expression into its script`);
			}
		}
	});

	it("smoke-tests both image platforms before the push", () => {
		const names = steps("image").map((step) => step.name);
		assert.ok(names.indexOf("Smoke test each platform") < names.indexOf("Push"));
		const smoke = steps("image").find((step) => step.name === "Smoke test each platform").run;
		assert.match(smoke, /linux\/amd64 linux\/arm64/);
		assert.match(smoke, /--version/);
		// The browser built-in tool runs in each platform's image before anything is pushed.
		assert.match(smoke, /--entrypoint node fingers:smoke \/opt\/smoke\/browser-smoke\.mjs/);
		const dockerfile = readFileSync(join(root, "docker/fingers/Dockerfile"), "utf8");
		assert.match(dockerfile, /apt-get install[^\n]* chromium/);
		assert.match(dockerfile, /FINGERS_BROWSER_PATH=\/usr\/bin\/chromium/);
		const push = steps("image").find((step) => step.name === "Push");
		assert.equal(push.if, "needs.prepare.outputs.publish == 'true'");
		assert.equal(push.with.platforms, "linux/amd64,linux/arm64");
	});

	it("publishes from main only while FINGERS_PRERELEASE_ON_MAIN is on, and dispatch is a dry run by default", () => {
		assert.match(jobs.prepare.if, /vars\.FINGERS_PRERELEASE_ON_MAIN == 'true'/);
		assert.match(jobs.prepare.if, /startsWith\(github\.ref, 'refs\/tags\/'\)/);
		assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true);
		assert.equal(jobs["github-release"].if, "needs.prepare.outputs.github_release == 'true'");
	});

	it("refuses a tag that is not on main and checks it against the packages", () => {
		const mode = steps("prepare").find((step) => step.name === "Release mode").run;
		assert.match(mode, /merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/);
		const check = steps("prepare").find((step) => step.name === "Release check").run;
		assert.match(check, /release-check\.mjs check --tag "\$TAG"/);
	});
});
