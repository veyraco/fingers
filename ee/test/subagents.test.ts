// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * Sub-agents (F18): the engine on real git repositories with stand-in children (parallel children on disjoint files
 * merge into the parent's working tree; a queued child waits for its dependencies and sees their changes; a failed
 * child does not fail the call; per-agent cost sums to the call's usage; the budget, the parent's abort, steer and
 * stop reach the right children; conflicts keep the worktree; bad requests are refused), and the feature through the
 * real gate, ee module and core extension with real child sessions (on only from the tier that includes sub-agents;
 * children on a cheaper model; their changes merged; /agents).
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	EeCommandContext,
	EeEntitlement,
	SubagentChild,
	SubagentChildOptions,
	SubagentChildOutcome,
	SubagentEvent,
	SubagentInfo,
	SubagentRunHost,
	SubagentSpec,
} from "@veyraco/fingers";
import type { Message } from "@veyraco/fingers-ai";
import {
	type AssistantMessageEventStream,
	calculateCost,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
} from "@veyraco/fingers-ai";
import { afterEach, describe, expect, it } from "vitest";
import { EditionGate } from "../../packages/coding-agent/src/core/edition/gate.ts";
import { EditionToolHooks } from "../../packages/coding-agent/src/core/edition/tool-hooks.ts";
import type { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import { SavingsLedger } from "../../packages/coding-agent/src/core/savings-ledger.ts";
import { SubagentEngines } from "../../packages/coding-agent/src/core/subagents/registry.ts";
import { AGENTS_TOOL, createSubagentsExtension } from "../../packages/coding-agent/src/extensions/subagents/index.ts";
import { createHarness, createTestUiContext, type Harness } from "../../packages/coding-agent/test/suite/harness.ts";
import * as ee from "../src/index.ts";
import { addUsage, emptyUsage, resultText, SubagentEngineImpl, validateSpecs } from "../src/subagents/engine.ts";
import { agentListLine, Subagents } from "../src/subagents/index.ts";

type Usage = SubagentInfo["usage"];

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const GIT_ENV = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined };

function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
		{ cwd, encoding: "utf8", env: GIT_ENV as NodeJS.ProcessEnv },
	);
}

/** A repository with a.txt, b.txt and src/c.txt committed. */
function repo(): string {
	const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "fingers-subagents-repo-")));
	dirs.push(dir);
	git(dir, "init", "-q", "-b", "main");
	writeFileSync(join(dir, "a.txt"), "a1\na2\na3\n");
	writeFileSync(join(dir, "b.txt"), "b1\n");
	mkdirSync(join(dir, "src"));
	writeFileSync(join(dir, "src", "c.txt"), "c1\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "init");
	return dir;
}

function usageOf(costTotal: number, tokens = 100): Usage {
	return {
		input: tokens,
		output: tokens / 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: tokens * 1.5,
		cost: { input: costTotal / 2, output: costTotal / 2, cacheRead: 0, cacheWrite: 0, total: costTotal },
	};
}

/** What a stand-in child's script can do. */
interface ChildControl {
	options: SubagentChildOptions;
	steered: string[];
	aborted: Promise<void>;
	isAborted(): boolean;
	setUsage(usage: Usage): void;
	approval(waiting: boolean): void;
}

type Script = (child: ChildControl) => Promise<SubagentChildOutcome>;

interface FakeHost extends SubagentRunHost {
	events: SubagentEvent[];
	children: Map<string, ChildControl>;
	running(): number;
	maxRunning: number;
	controller: AbortController;
}

function fakeHost(cwd: string, scripts: Record<string, Script>, budget?: (costUsd: number) => boolean): FakeHost {
	const controller = new AbortController();
	let running = 0;
	const host: FakeHost = {
		cwd,
		signal: controller.signal,
		controller,
		events: [],
		children: new Map(),
		maxRunning: 0,
		running: () => running,
		pickModel: (kind) => ({
			provider: "anthropic",
			id: kind === "search" ? "claude-haiku-4-5" : "claude-sonnet-4-5",
		}),
		report: (event) => host.events.push(event),
		budgetReached: (cost) => budget?.(cost) ?? false,
		async startChild(options): Promise<SubagentChild> {
			const script = scripts[options.label];
			if (!script) throw new Error(`no script for ${options.label}`);
			let usage = emptyUsage();
			let aborted = false;
			let onAbort!: () => void;
			const abortedPromise = new Promise<void>((resolve) => {
				onAbort = resolve;
			});
			const usageListeners = new Set<(usage: Usage) => void>();
			const approvalListeners = new Set<(waiting: boolean) => void>();
			let active = false;
			const control: ChildControl = {
				options,
				steered: [],
				aborted: abortedPromise,
				isAborted: () => aborted,
				setUsage(next) {
					usage = next;
					for (const listener of usageListeners) listener(next);
				},
				approval(waiting) {
					for (const listener of approvalListeners) listener(waiting);
				},
			};
			host.children.set(options.id, control);
			return {
				id: options.id,
				async run() {
					active = true;
					running++;
					host.maxRunning = Math.max(host.maxRunning, running);
					try {
						return await script(control);
					} catch (error) {
						return { status: "failed", summary: error instanceof Error ? error.message : String(error) };
					} finally {
						running--;
						active = false;
					}
				},
				steer(text) {
					if (!active) return false;
					control.steered.push(text);
					return true;
				},
				abort() {
					aborted = true;
					onAbort();
				},
				usage: () => usage,
				onUsage(listener) {
					usageListeners.add(listener);
					return () => usageListeners.delete(listener);
				},
				onApproval(listener) {
					approvalListeners.add(listener);
					return () => approvalListeners.delete(listener);
				},
				dispose() {},
			};
		},
	};
	return host;
}

/** A script that writes `files` (relative to the child's directory), costs `cost` and answers `summary`. */
function writes(files: Record<string, string>, cost = 0.01, summary = "Done."): Script {
	return async (child) => {
		for (const [name, content] of Object.entries(files)) writeFileSync(join(child.options.cwd, name), content);
		child.setUsage(usageOf(cost));
		return { status: "done", summary };
	};
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function statusLog(host: FakeHost): string[] {
	return host.events.map(
		(event) => `${event.type.replace("subagent_", "")}:${event.agent.label}:${event.agent.status}`,
	);
}

/** Waits until `condition` holds (at most 10 s). */
async function until(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function specs(...list: SubagentSpec[]): SubagentSpec[] {
	return list;
}

describe("sub-agent engine", () => {
	it("runs two children in parallel on disjoint files and merges both into the working tree", async () => {
		const root = repo();
		// The parent's unfinished work: a tracked change and a new file, which the children must see.
		writeFileSync(join(root, "b.txt"), "b1\nparent\n");
		writeFileSync(join(root, "notes.md"), "draft\n");
		const headBefore = git(root, "rev-parse", "HEAD");
		const bothStarted = deferred();
		let started = 0;
		const seen: Record<string, string> = {};
		const together =
			(name: string, file: string, content: string): Script =>
			async (child) => {
				seen[name] =
					`${readFileSync(join(child.options.cwd, "b.txt"), "utf8")}|${readFileSync(join(child.options.cwd, "notes.md"), "utf8")}`;
				if (++started === 2) bothStarted.resolve();
				// Each waits for the other: only a parallel run gets past this.
				await Promise.race([
					bothStarted.promise,
					new Promise((_, reject) => setTimeout(() => reject(new Error("not parallel")), 5_000)),
				]);
				writeFileSync(join(child.options.cwd, file), content);
				child.setUsage(usageOf(name === "alpha" ? 0.02 : 0.03));
				return { status: "done", summary: `${name} finished` };
			};
		const host = fakeHost(root, {
			alpha: together("alpha", "a.txt", "a1\nalpha\na3\n"),
			beta: together("beta", "new-beta.txt", "beta\n"),
		});
		const engine = new SubagentEngineImpl();
		const result = await engine.run(
			{
				toolCallId: "call_1",
				agents: specs({ label: "alpha", task: "edit a" }, { label: "beta", task: "add beta" }),
			},
			host,
		);

		expect(host.maxRunning).toBe(2);
		expect(result.agents.map((agent) => [agent.label, agent.status, agent.merged, agent.filesChanged])).toEqual([
			["alpha", "done", true, 1],
			["beta", "done", true, 1],
		]);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a1\nalpha\na3\n");
		expect(readFileSync(join(root, "new-beta.txt"), "utf8")).toBe("beta\n");
		// The parent's own changes are still there, and the children saw them.
		expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("b1\nparent\n");
		expect(seen).toEqual({ alpha: "b1\nparent\n|draft\n", beta: "b1\nparent\n|draft\n" });
		// Nothing else changed: HEAD, the index, no worktree left, nothing of .fingers in git status.
		expect(git(root, "rev-parse", "HEAD")).toBe(headBefore);
		expect(git(root, "diff", "--cached", "--name-only")).toBe("");
		expect(git(root, "status", "--porcelain").split("\n").filter(Boolean).sort()).toEqual([
			" M a.txt",
			" M b.txt",
			"?? new-beta.txt",
			"?? notes.md",
		]);
		expect(git(root, "worktree", "list").trim().split("\n")).toHaveLength(1);
		expect(readdirSync(join(root, ".fingers", "worktrees"))).toEqual([".gitignore"]);
		// Lifecycle in contract order.
		expect(statusLog(host)).toEqual([
			"started:alpha:running",
			"started:beta:running",
			"finished:alpha:done",
			"finished:beta:done",
		]);
		expect(result.agents[0]!.worktree).toMatch(/^\.fingers\/worktrees\/sub_\d+$/);
		expect(result.agents[0]!.model).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
	});

	it("keeps a child with dependencies queued until they finish, then starts it on their merged changes", async () => {
		const root = repo();
		const release = deferred();
		let schemaSawModel = "";
		const host = fakeHost(root, {
			model: async (child) => {
				await release.promise;
				writeFileSync(join(child.options.cwd, "model.ts"), "export type User = { id: string };\n");
				return { status: "done", summary: "model written" };
			},
			api: async (child) => {
				schemaSawModel = readFileSync(join(child.options.cwd, "model.ts"), "utf8");
				writeFileSync(join(child.options.cwd, "api.ts"), "import type { User } from './model';\n");
				return { status: "done", summary: "api written" };
			},
		});
		const engine = new SubagentEngineImpl();
		const run = engine.run(
			{
				toolCallId: "call_2",
				agents: specs(
					{ label: "api", task: "write the api", depends_on: ["model"] },
					{ label: "model", task: "model" },
				),
			},
			host,
		);
		await until(() => host.children.size === 1);
		// Queued: started, not running, waiting for model's id.
		const started = host.events.filter((event) => event.type === "subagent_started");
		const apiStarted = started.find((event) => event.agent.label === "api")!;
		const modelStarted = started.find((event) => event.agent.label === "model")!;
		expect(apiStarted.agent.status).toBe("queued");
		expect(apiStarted.agent.dependsOn).toEqual([modelStarted.agent.id]);
		expect(host.children.has(apiStarted.agent.id)).toBe(false);
		release.resolve();
		const result = await run;
		expect(schemaSawModel).toBe("export type User = { id: string };\n");
		expect(statusLog(host)).toEqual([
			"started:api:queued",
			"started:model:running",
			"finished:model:done",
			"updated:api:running",
			"finished:api:done",
		]);
		expect(result.agents.every((agent) => agent.merged)).toBe(true);
		expect(existsSync(join(root, "api.ts"))).toBe(true);
	});

	it("does not fail the call when a child fails; its dependants stop and its changes stay in its worktree", async () => {
		const root = repo();
		const host = fakeHost(root, {
			good: writes({ "good.txt": "ok\n" }, 0.01, "good done"),
			bad: async (child) => {
				writeFileSync(join(child.options.cwd, "half.txt"), "half\n");
				child.setUsage(usageOf(0.005));
				return { status: "failed", summary: "Model error: overloaded" };
			},
			after: writes({ "after.txt": "x\n" }),
			crash: async () => {
				throw new Error("boom");
			},
		});
		const engine = new SubagentEngineImpl();
		const result = await engine.run(
			{
				toolCallId: "call_3",
				agents: specs(
					{ label: "good", task: "g" },
					{ label: "bad", task: "b" },
					{ label: "after", task: "a", depends_on: ["bad"] },
					{ label: "crash", task: "c" },
				),
			},
			host,
		);
		const byLabel = Object.fromEntries(result.agents.map((agent) => [agent.label, agent]));
		expect(byLabel.good).toMatchObject({ status: "done", merged: true, summary: "good done" });
		expect(byLabel.bad!.status).toBe("failed");
		expect(byLabel.bad!.summary).toBe(`Model error: overloaded Its changes are kept in ${byLabel.bad!.worktree}.`);
		expect(byLabel.bad!.keptWorktree).toBe(byLabel.bad!.worktree);
		expect(readFileSync(join(root, byLabel.bad!.worktree!, "half.txt"), "utf8")).toBe("half\n");
		expect(existsSync(join(root, "half.txt"))).toBe(false);
		expect(byLabel.after).toMatchObject({ status: "stopped" });
		expect(byLabel.after!.summary).toBe(`Not started: ${byLabel.bad!.id} (bad) did not finish (it failed).`);
		expect(host.children.has(byLabel.after!.id)).toBe(false);
		expect(byLabel.crash).toMatchObject({ status: "failed", summary: "boom" });
		expect(existsSync(join(root, "good.txt"))).toBe(true);
		expect(result.text).toContain(`${byLabel.bad!.id} bad on claude-sonnet-4-5: failed.`);
	});

	it("sums every child's usage into the call's usage", async () => {
		const root = repo();
		const host = fakeHost(root, {
			one: writes({}, 0.0042),
			two: writes({}, 0.0158),
			three: async (child) => {
				child.setUsage(usageOf(0.001));
				return { status: "failed", summary: "nope" };
			},
		});
		const result = await new SubagentEngineImpl().run(
			{
				toolCallId: "c",
				agents: specs({ label: "one", task: "1" }, { label: "two", task: "2" }, { label: "three", task: "3" }),
			},
			host,
		);
		const perAgent = result.agents.reduce((sum, agent) => sum + agent.usage.cost.total, 0);
		expect(perAgent).toBeCloseTo(0.021, 12);
		expect(result.usage.cost.total).toBeCloseTo(perAgent, 12);
		expect(result.usage.input).toBe(300);
		expect(result.usage).toEqual(result.agents.reduce((sum, agent) => addUsage(sum, agent.usage), emptyUsage()));
	});

	it("runs at most maxParallel children at once", async () => {
		const root = repo();
		const release = deferred();
		const held: Script = async () => {
			await release.promise;
			return { status: "done", summary: "ok" };
		};
		const host = fakeHost(root, { a: held, b: held, c: writes({}) });
		const engine = new SubagentEngineImpl({ maxParallel: 2 });
		const run = engine.run(
			{
				toolCallId: "c",
				agents: specs({ label: "a", task: "a" }, { label: "b", task: "b" }, { label: "c", task: "c" }),
			},
			host,
		);
		await until(() => host.running() === 2);
		// Time for a third child to start if the limit did not hold.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(host.running()).toBe(2);
		expect(host.children.size).toBe(2);
		release.resolve();
		const result = await run;
		expect(host.maxRunning).toBe(2);
		expect(statusLog(host).slice(0, 3)).toEqual(["started:a:running", "started:b:running", "started:c:queued"]);
		expect(statusLog(host)).toContain("updated:c:running");
		expect(result.agents.every((agent) => agent.status === "done")).toBe(true);
	});

	it("keeps the worktree when a finished child's changes no longer apply", async () => {
		const root = repo();
		const host = fakeHost(root, {
			child: async (child) => {
				writeFileSync(join(child.options.cwd, "a.txt"), "a1\nchild\na3\n");
				// Meanwhile the parent changed the same line.
				writeFileSync(join(root, "a.txt"), "a1\nparent\na3\n");
				return { status: "done", summary: "changed a" };
			},
		});
		const result = await new SubagentEngineImpl().run(
			{ toolCallId: "c", agents: specs({ label: "child", task: "x" }) },
			host,
		);
		const [agent] = result.agents;
		expect(agent).toMatchObject({ status: "done", merged: false, keptWorktree: agent!.worktree, filesChanged: 1 });
		expect(agent!.summary).toContain("Not merged: its changes do not apply to the working tree");
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a1\nparent\na3\n");
		expect(readFileSync(join(root, agent!.worktree!, "a.txt"), "utf8")).toBe("a1\nchild\na3\n");
		expect(resultText(result.agents)).toContain("done, NOT merged (1 file changed)");
	});

	it("stops every child once their spend reaches the session's budget", async () => {
		const root = repo();
		const spender: Script = async (child) => {
			child.setUsage(usageOf(0.6));
			await child.aborted;
			return { status: "stopped", summary: "Stopped." };
		};
		const host = fakeHost(root, { a: spender, b: spender, c: writes({}) }, (cost) => cost >= 1);
		const result = await new SubagentEngineImpl({ maxParallel: 2 }).run(
			{
				toolCallId: "c",
				agents: specs({ label: "a", task: "a" }, { label: "b", task: "b" }, { label: "c", task: "c" }),
			},
			host,
		);
		expect(result.agents.map((agent) => [agent.label, agent.status, agent.summary])).toEqual([
			["a", "stopped", "Stopped: the session's budget is reached."],
			["b", "stopped", "Stopped: the session's budget is reached."],
			["c", "stopped", "Stopped: the session's budget is reached."],
		]);
		expect(host.children.has(result.agents[2]!.id)).toBe(false);
		expect(result.usage.cost.total).toBeCloseTo(1.2, 12);
	});

	it("starts no child when the session's budget is already reached", async () => {
		const root = repo();
		const host = fakeHost(root, { a: writes({ "a.txt": "x\n" }), b: writes({}) }, () => true);
		const result = await new SubagentEngineImpl().run(
			{ toolCallId: "c", agents: specs({ label: "a", task: "a" }, { label: "b", task: "b", depends_on: ["a"] }) },
			host,
		);
		expect(result.agents.map((agent) => [agent.label, agent.status, agent.summary])).toEqual([
			["a", "stopped", "Stopped: the session's budget is reached."],
			["b", "stopped", "Stopped: the session's budget is reached."],
		]);
		expect(host.children.size).toBe(0);
		expect(statusLog(host)).toEqual([
			"started:a:queued",
			"started:b:queued",
			"finished:a:stopped",
			"finished:b:stopped",
		]);
		expect(result.usage).toEqual(emptyUsage());
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a1\na2\na3\n");
		expect(git(root, "worktree", "list").trim().split("\n")).toHaveLength(1);
	});

	it("asks the budget again before each child starts", async () => {
		const root = repo();
		let reached = false;
		const host = fakeHost(
			root,
			{
				a: async (child) => {
					child.setUsage(usageOf(0.01));
					// Reached after this child's last usage report, as when other spend crosses the cap meanwhile.
					reached = true;
					return { status: "done", summary: "a done" };
				},
				b: writes({ "b.txt": "x\n" }),
			},
			() => reached,
		);
		const result = await new SubagentEngineImpl({ maxParallel: 1 }).run(
			{ toolCallId: "c", agents: specs({ label: "a", task: "a" }, { label: "b", task: "b" }) },
			host,
		);
		expect(result.agents.map((agent) => [agent.label, agent.status, agent.summary])).toEqual([
			["a", "done", "a done"],
			["b", "stopped", "Stopped: the session's budget is reached."],
		]);
		expect([...host.children.values()].map((child) => child.options.label)).toEqual(["a"]);
		expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("b1\n");
	});

	it("ends a child whose session could not be made as failed and runs the others", async () => {
		const root = repo();
		// No script for "broken": the host's startChild rejects, as for an unknown model.
		const host = fakeHost(root, { a: writes({ "a-new.txt": "a\n" }), c: writes({ "c-new.txt": "c\n" }) });
		const result = await new SubagentEngineImpl().run(
			{
				toolCallId: "c",
				agents: specs({ label: "a", task: "a" }, { label: "broken", task: "b" }, { label: "c", task: "c" }),
			},
			host,
		);
		const byLabel = Object.fromEntries(result.agents.map((agent) => [agent.label, agent]));
		expect(byLabel.broken).toMatchObject({ status: "failed", summary: "Could not run: no script for broken" });
		expect(byLabel.broken!.keptWorktree).toBeUndefined();
		expect(byLabel.a).toMatchObject({ status: "done", merged: true });
		expect(byLabel.c).toMatchObject({ status: "done", merged: true });
		expect(existsSync(join(root, "a-new.txt"))).toBe(true);
		expect(existsSync(join(root, "c-new.txt"))).toBe(true);
		expect(git(root, "worktree", "list").trim().split("\n")).toHaveLength(1);
	});

	it("stops the children when the parent's run is stopped", async () => {
		const root = repo();
		const host = fakeHost(root, {
			a: async (child) => {
				setTimeout(() => host.controller.abort(), 10);
				await child.aborted;
				return { status: "stopped", summary: "Stopped." };
			},
			b: writes({}),
		});
		const result = await new SubagentEngineImpl().run(
			{ toolCallId: "c", agents: specs({ label: "a", task: "a" }, { label: "b", task: "b", depends_on: ["a"] }) },
			host,
		);
		expect(result.agents.map((agent) => [agent.status, agent.summary])).toEqual([
			["stopped", "Stopped: the parent's run was stopped."],
			["stopped", "Stopped: the parent's run was stopped."],
		]);
	});

	it("sends a steer to the right child and stops a queued or running child", async () => {
		const root = repo();
		const engine = new SubagentEngineImpl({ maxParallel: 2 });
		const steeredOnce = deferred();
		const host = fakeHost(root, {
			a: async (child) => {
				await steeredOnce.promise;
				return { status: "done", summary: `a got ${child.steered.join(",")}` };
			},
			b: async (child) => {
				await child.aborted;
				return { status: "stopped", summary: "Stopped." };
			},
			c: writes({}),
		});
		const run = engine.run(
			{
				toolCallId: "c",
				agents: specs(
					{ label: "a", task: "a" },
					{ label: "b", task: "b" },
					{ label: "c", task: "c", depends_on: ["a"] },
				),
			},
			host,
		);
		await until(() => engine.list().length === 3);
		const ids = Object.fromEntries(engine.list().map((agent) => [agent.label, agent.id]));
		await until(() => host.children.has(ids.a!) && host.children.has(ids.b!));
		expect(engine.steer(ids.c!, "too early")).toBe(false);
		expect(engine.steer(ids.a!, "use the helper")).toBe(true);
		expect(host.children.get(ids.b!)!.steered).toEqual([]);
		// A queued child ends at once; a running one when its run returns.
		expect(engine.stop(ids.c!)).toBe(true);
		expect(engine.list().find((agent) => agent.id === ids.c)!.status).toBe("stopped");
		expect(engine.stop(ids.b!)).toBe(true);
		steeredOnce.resolve();
		const result = await run;
		expect(result.agents.map((agent) => [agent.label, agent.status, agent.summary])).toEqual([
			["a", "done", "a got use the helper"],
			["b", "stopped", "Stopped by the person."],
			["c", "stopped", "Stopped by the person."],
		]);
		expect(engine.stop(ids.a!)).toBe(false);
		expect(engine.steer(ids.a!, "late")).toBe(false);
	});

	it("never reuses the id of a worktree an earlier process kept", async () => {
		const root = repo();
		const kept = fakeHost(root, {
			a: async (child) => {
				writeFileSync(join(child.options.cwd, "half.txt"), "half\n");
				return { status: "failed", summary: "Model error: overloaded" };
			},
		});
		const first = await new SubagentEngineImpl().run(
			{ toolCallId: "c", agents: specs({ label: "a", task: "a" }) },
			kept,
		);
		expect(first.agents[0]).toMatchObject({ id: "sub_1", keptWorktree: ".fingers/worktrees/sub_1" });
		// A new process numbers from 1 again.
		const host = fakeHost(root, { b: writes({ "b2.txt": "b\n" }) });
		const second = await new SubagentEngineImpl().run(
			{ toolCallId: "c", agents: specs({ label: "b", task: "b" }) },
			host,
		);
		expect(second.agents[0]).toMatchObject({ id: "sub_2", status: "done", merged: true });
		expect(readFileSync(join(root, ".fingers", "worktrees", "sub_1", "half.txt"), "utf8")).toBe("half\n");
	});

	it("reports waiting for an approval as a status", async () => {
		const root = repo();
		const host = fakeHost(root, {
			a: async (child) => {
				child.approval(true);
				child.approval(false);
				return { status: "done", summary: "ok" };
			},
		});
		await new SubagentEngineImpl().run({ toolCallId: "c", agents: specs({ label: "a", task: "a" }) }, host);
		expect(statusLog(host)).toEqual([
			"started:a:running",
			"updated:a:waiting_approval",
			"updated:a:running",
			"finished:a:done",
		]);
	});

	it("runs a child in the parent's subdirectory of its worktree", async () => {
		const root = repo();
		const host = fakeHost(join(root, "src"), { a: writes({ "d.txt": "d\n" }) });
		const result = await new SubagentEngineImpl().run(
			{ toolCallId: "c", agents: specs({ label: "a", task: "a" }) },
			host,
		);
		expect(host.children.get(result.agents[0]!.id)!.options.cwd).toBe(join(root, result.agents[0]!.worktree!, "src"));
		expect(readFileSync(join(root, "src", "d.txt"), "utf8")).toBe("d\n");
	});

	it("refuses bad requests and work outside a repository", async () => {
		expect(() => validateSpecs([])).toThrow("start at least one");
		expect(() => validateSpecs(Array.from({ length: 9 }, (_, i) => ({ label: `l${i}`, task: "t" })))).toThrow(
			"at most 8",
		);
		expect(() => validateSpecs(specs({ label: "a", task: "t" }, { label: "a", task: "u" }))).toThrow("used twice");
		expect(() => validateSpecs(specs({ label: "a", task: "t", depends_on: ["zz"] }))).toThrow(
			'"a" depends on "zz", which is not a sub-agent of this call.',
		);
		expect(() => validateSpecs(specs({ label: "a", task: "t", depends_on: ["a"] }))).toThrow("depends on itself");
		expect(() =>
			validateSpecs(
				specs(
					{ label: "a", task: "t", depends_on: ["c"] },
					{ label: "b", task: "t", depends_on: ["a"] },
					{ label: "c", task: "t", depends_on: ["b"] },
				),
			),
		).toThrow("the dependencies form a cycle (a -> c -> b -> a)");
		expect(() => validateSpecs(specs({ label: "a", task: " " }))).toThrow("task");
		expect(() => validateSpecs([{ label: "a", task: "t", kind: "deploy" as never }])).toThrow(
			'unknown kind "deploy"',
		);

		const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "fingers-not-a-repo-")));
		dirs.push(outside);
		const host = fakeHost(outside, { a: writes({}) });
		await expect(
			new SubagentEngineImpl().run({ toolCallId: "c", agents: specs({ label: "a", task: "a" }) }, host),
		).rejects.toThrow("Sub-agents need a git repository");
		expect(host.events).toEqual([]);
	});

	it("lists sub-agents for /agents and steers or stops them from there", async () => {
		const subagents = new Subagents();
		const root = repo();
		await subagents.engine.run(
			{ toolCallId: "c", agents: specs({ label: "lint", task: "fix lint" }) },
			fakeHost(root, { lint: writes({ "x.txt": "x\n" }, 0.0042) }),
		);
		const shown: string[] = [];
		const warned: string[] = [];
		const context = (args: string): EeCommandContext => ({
			args,
			cwd: root,
			entitlement: MEDIUM,
			showStatus: (message) => shown.push(message),
			showWarning: (message) => warned.push(message),
		});
		subagents.command(context(""));
		expect(shown[0]).toBe(
			"Sub-agents (1, $0.0042):\n  sub_1 lint · done, merged (1 files) · claude-sonnet-4-5 · $0.0042",
		);
		subagents.command(context("steer sub_1 hurry"));
		subagents.command(context("stop sub_1"));
		subagents.command(context("steer"));
		subagents.command(context("bogus"));
		expect(warned).toEqual([
			"sub_1 is not running.",
			"sub_1 is not running or queued.",
			"Usage: /agents, /agents steer <id> <message>, /agents stop <id>",
			"Usage: /agents, /agents steer <id> <message>, /agents stop <id>",
		]);
		const empty: string[] = [];
		new Subagents().command({ ...context(""), showStatus: (message) => empty.push(message) });
		expect(empty[0]).toContain("No sub-agents yet");
		expect(agentListLine({ ...subagents.engine.list()[0]!, label: "a\u001b[31mred\nnext" })).not.toMatch(
			/[\u001b\n]/,
		);
	});
});

const MEDIUM: EeEntitlement = {
	signedIn: true,
	source: "connect",
	org: "org_acme",
	orgName: "Acme",
	tier: "medium",
	fingersEnabled: true,
};
const LOW: EeEntitlement = { ...MEDIUM, tier: "low" };

const BIG = { id: "big", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
const SMALL = { id: "small", cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } };

/** The faux provider reports no cost; price every call at the model's list price like a real provider does. */
function priceStream<T extends (...args: any[]) => any>(inner: T): T {
	return (async (model: Parameters<T>[0], context: Parameters<T>[1], options: Parameters<T>[2]) => {
		const source: AssistantMessageEventStream = await inner(model, context, options);
		const out = createAssistantMessageEventStream();
		void (async () => {
			for await (const event of source) {
				if (event.type === "done") calculateCost(model, event.message.usage);
				if (event.type === "error") calculateCost(model, event.error.usage);
				out.push(event);
			}
			out.end(await source.result());
		})();
		return out;
	}) as unknown as T;
}

function messageText(message: Message | undefined): string {
	if (!message || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

describe("sub-agents through the gate, the ee module and real child sessions", () => {
	async function setup(entitlement: EeEntitlement) {
		const toolHooks = new EditionToolHooks();
		const savings = new SavingsLedger();
		const engines = new SubagentEngines();
		const gate = new EditionGate({ loadModule: async () => ee, toolHooks, savings, subagents: engines });
		await gate.setEntitlement(entitlement);
		const agentDir = mkdtempSync(join(tmpdir(), "fingers-subagents-agent-"));
		dirs.push(agentDir);
		const harness = await createHarness({
			models: [BIG, SMALL],
			extensionFactories: [
				{ name: "subagents", factory: createSubagentsExtension({ engines, hooks: toolHooks, agentDir }) },
			],
		});
		harnesses.push(harness);
		harness.session.agent.streamFunction = priceStream(harness.session.agent.streamFunction);
		const runtime = harness.session.modelRuntime as ModelRuntime;
		runtime.streamSimple = priceStream(runtime.streamSimple.bind(runtime));
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });
		// The session works in a repository.
		const root = realpathSync.native(harness.tempDir);
		git(root, "init", "-q", "-b", "main");
		writeFileSync(join(root, "README.md"), "# app\n");
		git(root, "add", "-A");
		git(root, "commit", "-qm", "init");
		return { gate, harness, savings, engines, root };
	}

	interface Call {
		child: boolean;
		task: string;
		tools: string[];
		model: string;
	}

	function script(calls: Call[]) {
		return (context: { messages: Message[] }, _options: unknown, _state: unknown, model: { id: string }) => {
			const system = JSON.stringify(context.messages.filter((message) => message.role === "system"));
			const task = messageText(context.messages.find((message) => message.role === "user"));
			const turn = context.messages.filter((message) => message.role === "assistant").length;
			const child = system.includes("You are sub-agent sub_");
			calls.push({
				child,
				task,
				tools: getCurrentTools(context.messages).map((tool) => tool.name),
				model: model.id,
			});
			if (!child) {
				if (turn === 0) {
					return fauxAssistantMessage(
						[
							fauxToolCall(AGENTS_TOOL, {
								start: [
									{ label: "docs", task: "Write docs/guide.md" },
									{ label: "tests", task: "Write test/app.test.ts" },
								],
							}),
						],
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("Docs and tests are in.");
			}
			const path = task.replace("Write ", "");
			if (turn === 0) {
				return fauxAssistantMessage([fauxToolCall("write", { path, content: `${path}\n` })], {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage(`Wrote ${path}.`);
		};
	}

	it("offers the tool on a tier with sub-agents; children run on a cheaper model and their work is merged", async () => {
		const { gate, harness, savings, engines, root } = await setup(MEDIUM);
		expect(engines.engine()).toBe(ee.subagents.engine);
		const calls: Call[] = [];
		const step = script(calls);
		harness.setResponses(Array.from({ length: 6 }, () => step));
		await harness.session.prompt("Add docs and tests.");

		expect(calls[0]!.tools).toContain(AGENTS_TOOL);
		const childCalls = calls.filter((call) => call.child);
		expect(childCalls).toHaveLength(4);
		// ee routing (token saving, included in the tier) picked the cheaper model of the same provider.
		expect(childCalls.every((call) => call.model === "small" && !call.tools.includes(AGENTS_TOOL))).toBe(true);
		expect(readFileSync(join(root, "docs", "guide.md"), "utf8")).toBe("docs/guide.md\n");
		expect(readFileSync(join(root, "test", "app.test.ts"), "utf8")).toBe("test/app.test.ts\n");
		expect(git(root, "worktree", "list").trim().split("\n")).toHaveLength(1);

		const result = harness.session.messages.findLast(
			(message) => message.role === "toolResult" && message.toolName === AGENTS_TOOL,
		);
		if (result?.role !== "toolResult") throw new Error("no agents result");
		const agents = (result.details as unknown as { agents: SubagentInfo[] }).agents;
		expect(agents.map((agent) => [agent.label, agent.status, agent.merged, agent.model?.id])).toEqual([
			["docs", "done", true, "small"],
			["tests", "done", true, "small"],
		]);
		const childCost = agents.reduce((sum, agent) => sum + agent.usage.cost.total, 0);
		expect(childCost).toBeGreaterThan(0);
		expect(result.usage?.cost.total).toBeCloseTo(childCost, 12);
		// What routing saved is in the savings ledger, once per routed child.
		const routed = savings.entries().filter((entry) => entry.technique === "model_routing");
		expect(routed).toHaveLength(2);
		expect(routed.every((entry) => (entry.costUsd ?? 0) > 0)).toBe(true);

		// /agents lists them.
		const shown: string[] = [];
		await gate.commandHandler("agents")?.({
			args: "",
			cwd: root,
			entitlement: MEDIUM,
			showStatus: (message) => shown.push(message),
			showWarning: () => {},
		});
		expect(shown[0]).toContain(`${agents[0]!.id} docs · done, merged (1 files) · small`);
		expect(shown[0]).toContain(`${agents[1]!.id} tests · done, merged (1 files) · small`);

		// The feature goes off: no tool on the next run.
		await gate.setEntitlement(LOW);
		harness.setResponses([step]);
		const before = calls.length;
		await harness.session.prompt("And now?");
		expect(calls[before]!.tools).not.toContain(AGENTS_TOOL);
	});

	it("offers no tool and no /agents below the tier that includes sub-agents", async () => {
		for (const entitlement of [LOW, { ...MEDIUM, signedIn: false }, { ...MEDIUM, fingersEnabled: false }]) {
			const { gate, harness, engines } = await setup(entitlement);
			expect(engines.engine()).toBeUndefined();
			expect(gate.commandHandler("agents")).toBeUndefined();
			const calls: Call[] = [];
			const capture = script(calls);
			harness.setResponses([
				(context, options, state, model) => {
					capture(context, options, state, model);
					return fauxAssistantMessage("ok");
				},
			]);
			await harness.session.prompt("Add docs and tests.");
			expect(calls[0]!.tools).not.toContain(AGENTS_TOOL);
		}
	});
});
