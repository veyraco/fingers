/**
 * Sub-agents (open core): the built-in `subagents` extension with a stand-in engine. The `agents` tool is offered
 * only while an engine is live; the child sessions it makes are real sessions on the parent's model runtime (same
 * credentials) in their own directory, with the parent's approvals asked in the parent's terminal one at a time and
 * no `agents` tool of their own; each child's model calls become the tool result's usage, so the session's cost and
 * budget count them; a child's spend counts toward the session's budget; the model per child comes from the routing
 * hooks, and what a routed child saved goes to them.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message, Usage } from "@veyraco/fingers-ai";
import {
	type AssistantMessageEventStream,
	calculateCost,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
} from "@veyraco/fingers-ai";
import { afterEach, describe, expect, it } from "vitest";
import { sessionUsageTotals } from "../src/core/budget.ts";
import { EditionGate } from "../src/core/edition/gate.ts";
import { EditionToolHooks } from "../src/core/edition/tool-hooks.ts";
import {
	EE_API_VERSION,
	type EeFeatureId,
	type EeRouteOutcome,
	type EeRouteRequest,
	type VeyraTier,
} from "../src/core/edition/types.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { SubagentEngines } from "../src/core/subagents/registry.ts";
import type {
	SubagentCheckpoint,
	SubagentEngine,
	SubagentEvent,
	SubagentInfo,
	SubagentRunHost,
	SubagentRunRequest,
	SubagentRunResult,
	SubagentTranscriptLine,
} from "../src/core/subagents/types.ts";
import { emptyUsage } from "../src/core/subagents/types.ts";
import { combineUsage } from "../src/core/usage-totals.ts";
import type { AskForApproval } from "../src/extensions/approvals/index.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { ApprovalQueue, subagentRules } from "../src/extensions/subagents/child-session.ts";
import {
	AGENTS_TOOL,
	createSubagentsExtension,
	type SubagentsExtensionOptions,
} from "../src/extensions/subagents/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const BIG = { id: "big", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
const SMALL = { id: "small", cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } };

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

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

function text(message: Message | undefined): string {
	if (!message || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

interface Call {
	child: boolean;
	task: string;
	system: string;
	tools: string[];
	model: string;
}

/**
 * One faux step for every call, parent or child: `script(task, turn)` answers the conversation that starts with the
 * user message `task` (`turn`: assistant messages so far), whichever session asks, in whatever order.
 */
function scripted(
	calls: Call[],
	script: (task: string, turn: number, context: { messages: Message[] }) => AssistantMessage,
) {
	return (context: { messages: Message[] }, _options: unknown, _state: unknown, model: { id: string }) => {
		const system = JSON.stringify(context.messages.filter((message) => message.role === "system"));
		const task = text(context.messages.find((message) => message.role === "user"));
		const turn = context.messages.filter((message) => message.role === "assistant").length;
		calls.push({
			child: system.includes("You are sub-agent sub_"),
			task,
			system,
			tools: getCurrentTools(context.messages).map((tool) => tool.name),
			model: model.id,
		});
		return script(task, turn, context);
	};
}

/** A stand-in engine: starts every child at once in `cwd(label)` and waits for all. */
class FakeEngine implements SubagentEngine {
	runs: { request: SubagentRunRequest; host: SubagentRunHost }[] = [];
	cwd: (label: string) => string = () => "";

	async run(request: SubagentRunRequest, host: SubagentRunHost): Promise<SubagentRunResult> {
		this.runs.push({ request, host });
		const agents = await Promise.all(
			request.agents.map(async (spec, index): Promise<SubagentInfo> => {
				const id = `sub_${index + 1}`;
				const model = host.pickModel(spec.kind ?? "code");
				const info: SubagentInfo = {
					id,
					parentId: "main",
					label: spec.label,
					task: spec.task,
					kind: spec.kind ?? "code",
					...(model ? { model } : {}),
					dependsOn: [],
					status: "running",
					usage: emptyUsage(),
				};
				host.report({ type: "subagent_started", agent: { ...info } });
				const child = await host.startChild({
					id,
					label: spec.label,
					task: spec.task,
					cwd: this.cwd(spec.label) || host.cwd,
					...(model ? { model } : {}),
				});
				const outcome = await child.run();
				info.usage = child.usage();
				child.dispose();
				info.status = outcome.status;
				info.summary = outcome.summary;
				host.report({ type: "subagent_finished", agent: { ...info } });
				return info;
			}),
		);
		const usage = agents.reduce<Usage>((sum, agent) => combineUsage(sum, agent.usage), emptyUsage());
		return { agents, usage, text: agents.map((agent) => `${agent.id}: ${agent.status}`).join("\n") };
	}
	steer(): boolean {
		return false;
	}
	stop(): boolean {
		return false;
	}
	list(): readonly SubagentInfo[] {
		return [];
	}
	pause(): boolean {
		return false;
	}
	async resume(): Promise<void> {}
	async checkpoint(): Promise<SubagentCheckpoint> {
		throw new Error("no checkpoints");
	}
	transcript(): SubagentTranscriptLine[] | undefined {
		return undefined;
	}
	async removeWorktree(): Promise<void> {}
}

async function setup(options: SubagentsExtensionOptions & { tui?: boolean } = {}) {
	const engines = options.engines ?? new SubagentEngines();
	// The children's agent directory (global AGENTS.md and skills): empty.
	const agentDir = mkdtempSync(join(tmpdir(), "fingers-subagents-agent-"));
	dirs.push(agentDir);
	const harness = await createHarness({
		models: [BIG, SMALL],
		extensionFactories: [{ name: "subagents", factory: createSubagentsExtension({ ...options, engines, agentDir }) }],
	});
	harnesses.push(harness);
	harness.session.agent.streamFunction = priceStream(harness.session.agent.streamFunction);
	const runtime = harness.session.modelRuntime as ModelRuntime & { streamSimple: ModelRuntime["streamSimple"] };
	runtime.streamSimple = priceStream(runtime.streamSimple.bind(runtime));
	if (options.tui !== false) {
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });
	}
	return { harness, engines };
}

function toolResult(harness: Harness) {
	const result = harness.session.messages.findLast(
		(message) => message.role === "toolResult" && message.toolName === AGENTS_TOOL,
	);
	if (!result || result.role !== "toolResult") throw new Error("no agents tool result");
	return result;
}

describe("the agents tool", () => {
	it("is offered only while a sub-agent engine is live", async () => {
		const { harness, engines } = await setup();
		const calls: Call[] = [];
		const answer = scripted(calls, () => fauxAssistantMessage("ok"));
		harness.setResponses([answer, answer, answer]);

		await harness.session.prompt("first");
		expect(calls[0]!.tools).not.toContain(AGENTS_TOOL);
		expect(calls[0]!.system).not.toContain("Split independent parts of a task across sub-agents");

		let on = true;
		engines.set(new FakeEngine(), () => on);
		await harness.session.prompt("second");
		expect(calls[1]!.tools).toContain(AGENTS_TOOL);
		expect(calls[1]!.system).toContain("Split independent parts of a task across sub-agents");

		// The feature went off (sign-out, tier change): the next run has no tool.
		on = false;
		await harness.session.prompt("third");
		expect(calls[2]!.tools).not.toContain(AGENTS_TOOL);
	});

	it("is a built-in extension", () => {
		expect(builtInExtensions.some((entry) => typeof entry !== "function" && entry.name === "subagents")).toBe(true);
	});

	it("runs children as real sessions in their own directory and counts their cost in the session", async () => {
		const { harness, engines } = await setup();
		const engine = new FakeEngine();
		engine.cwd = (label) => {
			const dir = join(harness.tempDir, "worktrees", label);
			mkdirSync(dir, { recursive: true });
			return dir;
		};
		engines.set(engine, () => true);
		const events: SubagentEvent[] = [];
		engines.onEvent((event) => events.push(event));
		const calls: Call[] = [];
		const step = scripted(calls, (task, turn) => {
			if (task === "Split the work.") {
				if (turn === 0) {
					return fauxAssistantMessage(
						[
							fauxToolCall(
								AGENTS_TOOL,
								{
									start: [
										{ label: "alpha", task: "Write alpha.txt" },
										{ label: "beta", task: "Write beta.txt", kind: "search" },
									],
								},
								{ id: "call_agents" },
							),
						],
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("Both parts are done.");
			}
			const name = task === "Write alpha.txt" ? "alpha" : "beta";
			if (turn === 0) {
				return fauxAssistantMessage([fauxToolCall("write", { path: `${name}.txt`, content: `${name}\n` })], {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage(`Wrote ${name}.txt.`);
		});
		harness.setResponses(Array.from({ length: 6 }, () => step));

		await harness.session.prompt("Split the work.");

		// Each child wrote in its own directory.
		expect(readFileSync(join(harness.tempDir, "worktrees", "alpha", "alpha.txt"), "utf8")).toBe("alpha\n");
		expect(readFileSync(join(harness.tempDir, "worktrees", "beta", "beta.txt"), "utf8")).toBe("beta\n");
		// Children got the sub-agent rules, the default tools and no agents tool; the parent got the tool.
		const childCalls = calls.filter((call) => call.child);
		expect(childCalls).toHaveLength(4);
		for (const call of childCalls) {
			expect(call.tools).not.toContain(AGENTS_TOOL);
			expect(call.tools).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));
		}
		expect(childCalls.find((call) => call.task === "Write alpha.txt")!.system).toContain(
			JSON.stringify(subagentRules({ id: "sub_1", label: "alpha", cwd: engine.cwd("alpha") })).slice(1, -1),
		);
		// Without routing hooks every child runs on the parent's model.
		expect(childCalls.every((call) => call.model === "big")).toBe(true);

		const result = toolResult(harness);
		const details = result.details as unknown as { agents: SubagentInfo[] };
		expect(details.agents.map((agent) => [agent.id, agent.status, agent.summary])).toEqual([
			["sub_1", "done", "Wrote alpha.txt."],
			["sub_2", "done", "Wrote beta.txt."],
		]);
		// Per-agent cost sums to the tool's usage, and the session's cost is the parent's calls plus that.
		const childCost = details.agents.reduce((sum, agent) => sum + agent.usage.cost.total, 0);
		expect(childCost).toBeGreaterThan(0);
		expect(result.usage?.cost.total).toBeCloseTo(childCost, 12);
		const parentCost = harness.session.messages
			.filter((message): message is AssistantMessage => message.role === "assistant")
			.reduce((sum, message) => sum + message.usage.cost.total, 0);
		expect(sessionUsageTotals(harness.sessionManager.getEntries()).cost).toBeCloseTo(parentCost + childCost, 12);
		expect(events.map((event) => `${event.type}:${event.agent.id}`)).toEqual(
			expect.arrayContaining(["subagent_started:sub_1", "subagent_finished:sub_1", "subagent_finished:sub_2"]),
		);
	});

	it("reads the worktree's project files only when the parent trusts the project", async () => {
		for (const trusted of [false, true]) {
			const { harness, engines } = await setup();
			harness.settingsManager.setProjectTrusted(trusted);
			const engine = new FakeEngine();
			engine.cwd = () => {
				const dir = join(harness.tempDir, "worktree");
				mkdirSync(join(dir, ".fingers"), { recursive: true });
				writeFileSync(join(dir, ".fingers", "APPEND_SYSTEM.md"), "PLANTED-PROJECT-RULE");
				return dir;
			};
			engines.set(engine, () => true);
			const calls: Call[] = [];
			const step = scripted(calls, (task, turn) =>
				task === "go" && turn === 0
					? fauxAssistantMessage([fauxToolCall(AGENTS_TOOL, { start: [{ label: "a", task: "child task" }] })], {
							stopReason: "toolUse",
						})
					: fauxAssistantMessage("ok"),
			);
			harness.setResponses(Array.from({ length: 3 }, () => step));
			await harness.session.prompt("go");
			const child = calls.find((call) => call.child)!;
			expect(child.system.includes("PLANTED-PROJECT-RULE")).toBe(trusted);
		}
	});

	it("asks the parent's approvals for a child's command, one question at a time, and a denial blocks it", async () => {
		const asked: { reason: string; command: string; parentSession: string }[] = [];
		let open = 0;
		let maxOpen = 0;
		const ask: AskForApproval = async (ctx, request) => {
			open++;
			maxOpen = Math.max(maxOpen, open);
			asked.push({
				reason: request.reason,
				command: request.command,
				parentSession: ctx.sessionManager.getSessionId(),
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			open--;
			return { decision: "deny", message: "Not now." };
		};
		const { harness, engines } = await setup({ ask });
		const engine = new FakeEngine();
		engines.set(engine, () => true);
		const waiting: boolean[] = [];
		const calls: Call[] = [];
		const step = scripted(calls, (task, turn, context) => {
			if (task === "Clean up.") {
				if (turn === 0) {
					return fauxAssistantMessage(
						[
							fauxToolCall(AGENTS_TOOL, {
								start: [
									{ label: "one", task: "Remove build one" },
									{ label: "two", task: "Remove build two" },
								],
							}),
						],
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("Done.");
			}
			if (turn === 0) {
				return fauxAssistantMessage([fauxToolCall("bash", { command: `rm -rf build-${task.slice(-3)}` })], {
					stopReason: "toolUse",
				});
			}
			const last = context.messages.at(-1);
			return fauxAssistantMessage(`Result: ${text(last)}`);
		});
		harness.setResponses(Array.from({ length: 6 }, () => step));
		const originalStart = engine.run.bind(engine);
		engine.run = async (request, host) =>
			originalStart(request, {
				...host,
				startChild: async (options) => {
					const child = await host.startChild(options);
					child.onApproval((value) => waiting.push(value));
					return child;
				},
			});

		await harness.session.prompt("Clean up.");

		expect(asked.map((entry) => entry.command).sort()).toEqual(["rm -rf build-one", "rm -rf build-two"]);
		expect(asked.every((entry) => entry.parentSession === harness.sessionManager.getSessionId())).toBe(true);
		const reasons = asked.map((entry) => entry.reason).sort();
		expect(reasons[0]).toMatch(/^Sub-agent sub_1 \(one\): \S/);
		expect(reasons[1]).toMatch(/^Sub-agent sub_2 \(two\): \S/);
		expect(maxOpen).toBe(1);
		// Each child waits for the person from the moment it asks (also while the other child's box is open).
		expect([...waiting].sort()).toEqual([false, false, true, true]);
		const details = toolResult(harness).details as unknown as { agents: SubagentInfo[] };
		for (const agent of details.agents) {
			expect(agent.summary).toContain("The user did not allow this command and said what to do instead: Not now.");
		}
	});

	it("counts the children's spend toward the session's budget", async () => {
		const { harness, engines } = await setup();
		const engine = new FakeEngine();
		engines.set(engine, () => true);
		let spent = 1;
		engines.setBudget(() => ({ spentUsd: spent, capUsd: 1.5 }));
		const step = scripted([], (task, turn) =>
			task === "go" && turn === 0
				? fauxAssistantMessage([fauxToolCall(AGENTS_TOOL, { start: [{ label: "a", task: "noop" }] })], {
						stopReason: "toolUse",
					})
				: fauxAssistantMessage("ok"),
		);
		harness.setResponses(Array.from({ length: 3 }, () => step));
		await harness.session.prompt("go");
		const host = engine.runs[0]!.host;
		expect(host.budgetReached(0.49)).toBe(false);
		expect(host.budgetReached(0.5)).toBe(true);
		spent = 0;
		expect(host.budgetReached(1.49)).toBe(false);
		engines.setBudget(() => undefined);
		expect(host.budgetReached(1_000)).toBe(false);
	});

	it("starts no sub-agent when the session's budget is already reached", async () => {
		const { harness, engines } = await setup();
		const engine = new FakeEngine();
		engines.set(engine, () => true);
		// The answer that asks for sub-agents reached the budget itself.
		engines.setBudget(() => ({ spentUsd: 2, capUsd: 1.5 }));
		const calls: Call[] = [];
		const step = scripted(calls, (task, turn) =>
			task === "go" && turn === 0
				? fauxAssistantMessage([fauxToolCall(AGENTS_TOOL, { start: [{ label: "a", task: "noop" }] })], {
						stopReason: "toolUse",
					})
				: fauxAssistantMessage("ok"),
		);
		harness.setResponses(Array.from({ length: 3 }, () => step));
		await harness.session.prompt("go");
		expect(engine.runs).toHaveLength(0);
		expect(calls.filter((call) => call.child)).toHaveLength(0);
		const result = toolResult(harness);
		expect(result.isError).toBe(true);
		expect(text(result as Message)).toContain("The session's budget is reached, so no sub-agents were started.");
		expect(result.usage).toBeUndefined();
	});

	it("runs two agents calls of one answer one after the other, so the second sees the first's spend", async () => {
		const { harness, engines } = await setup();
		const engine = new FakeEngine();
		let inRun = 0;
		let overlapped = false;
		const run = engine.run.bind(engine);
		engine.run = async (request, host) => {
			inRun++;
			if (inRun > 1) overlapped = true;
			try {
				return await run(request, host);
			} finally {
				inRun--;
			}
		};
		engines.set(engine, () => true);
		// What the children spent, recorded in the session by each agents call's result; any spend reaches the cap.
		const childSpend = () =>
			harness.sessionManager
				.getEntries()
				.reduce(
					(sum, entry) =>
						entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage
							? sum + entry.message.usage.cost.total
							: sum,
					0,
				);
		engines.setBudget(() => ({ spentUsd: childSpend(), capUsd: 1e-9 }));
		const calls: Call[] = [];
		const step = scripted(calls, (task, turn) => {
			if (task === "go") {
				return turn === 0
					? fauxAssistantMessage(
							[
								fauxToolCall(AGENTS_TOOL, { start: [{ label: "one", task: "Task one" }] }, { id: "call_1" }),
								fauxToolCall(AGENTS_TOOL, { start: [{ label: "two", task: "Task two" }] }, { id: "call_2" }),
							],
							{ stopReason: "toolUse" },
						)
					: fauxAssistantMessage("ok");
			}
			return fauxAssistantMessage(`${task}: done`);
		});
		harness.setResponses(Array.from({ length: 4 }, () => step));
		await harness.session.prompt("go");

		expect(overlapped).toBe(false);
		expect(engine.runs.map((entry) => entry.request.agents.map((agent) => agent.label))).toEqual([["one"]]);
		expect(calls.filter((call) => call.child).map((call) => call.task)).toEqual(["Task one"]);
		const results = harness.session.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === AGENTS_TOOL,
		);
		expect(results.map((message) => message.role === "toolResult" && message.isError)).toEqual([false, true]);
		expect(text(results[1] as Message)).toContain("The session's budget is reached, so no sub-agents were started.");
		expect(childSpend()).toBeGreaterThan(0);
	});

	it("goes away when the gate's feature goes off, without the gate activating again", async () => {
		const { harness, engines } = await setup();
		const engine = new FakeEngine();
		let needs: VeyraTier = "medium";
		const gate = new EditionGate({
			loadModule: async () => ({
				apiVersion: EE_API_VERSION,
				matrixVersion: "test.1",
				minimumTier: (feature: EeFeatureId) => (feature === "subagents" ? needs : "high"),
				activate: (host) => host.registerSubagentEngine("subagents", engine),
			}),
			subagents: engines,
		});
		await gate.setEntitlement({
			signedIn: true,
			source: "connect",
			org: "org_1",
			orgName: "Acme",
			tier: "medium",
			fingersEnabled: true,
			checkedAt: Date.now(),
		});
		const calls: Call[] = [];
		const answer = scripted(calls, () => fauxAssistantMessage("ok"));
		harness.setResponses([answer, answer]);

		expect(engines.engine()).toBe(engine);
		await harness.session.prompt("first");
		expect(calls[0]!.tools).toContain(AGENTS_TOOL);

		// The feature is off now (the gate asks the module's matrix live); nothing activates the gate again.
		needs = "high";
		expect(gate.state("subagents").on).toBe(false);
		expect(engines.engine()).toBeUndefined();
		await harness.session.prompt("second");
		expect(calls[1]!.tools).not.toContain(AGENTS_TOOL);
	});

	it("runs a child on the model routing picks and reports what that saved", async () => {
		const requests: EeRouteRequest[] = [];
		const outcomes: EeRouteOutcome[] = [];
		const hooks = new EditionToolHooks();
		hooks.set(
			[
				{
					feature: "token_saving",
					hooks: {
						routeModel: (request) => {
							requests.push(request);
							return request.candidates.find((candidate) => candidate.id === "small");
						},
						afterRoute: (outcome) => {
							outcomes.push(outcome);
							return "routed";
						},
					},
				},
			],
			() => true,
		);
		const notices: string[] = [];
		const { harness, engines } = await setup({ hooks });
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notices.push(message) }),
			mode: "tui",
		});
		engines.set(new FakeEngine(), () => true);
		const calls: Call[] = [];
		const step = scripted(calls, (task, turn) => {
			if (task === "go") {
				return turn === 0
					? fauxAssistantMessage(
							[
								fauxToolCall(AGENTS_TOOL, {
									start: [
										{ label: "finder", task: "Find the config", kind: "search" },
										{ label: "coder", task: "Fix the config" },
									],
								}),
							],
							{ stopReason: "toolUse" },
						)
					: fauxAssistantMessage("ok");
			}
			return fauxAssistantMessage(`${task}: done`);
		});
		harness.setResponses(Array.from({ length: 4 }, () => step));
		await harness.session.prompt("go");

		expect(requests.map((request) => [request.taskClass, request.current.id])).toEqual([
			["search", "big"],
			["review", "big"],
		]);
		expect(calls.filter((call) => call.child).map((call) => call.model)).toEqual(["small", "small"]);
		const details = toolResult(harness).details as unknown as { agents: SubagentInfo[] };
		expect(details.agents.map((agent) => agent.model)).toEqual([
			{ provider: harness.getModel().provider, id: "small" },
			{ provider: harness.getModel().provider, id: "small" },
		]);
		// The children run in parallel: either may finish first.
		expect(outcomes.map((outcome) => [outcome.taskClass, outcome.from.id, outcome.to.id]).sort()).toEqual([
			["review", "big", "small"],
			["search", "big", "small"],
		]);
		for (const outcome of outcomes) expect(outcome.wouldHaveCostUsd).toBeGreaterThan(outcome.costUsd);
		expect(notices.filter((notice) => notice === "routed")).toHaveLength(2);
	});

	it("answers that sub-agents are off when the engine went away during the run", async () => {
		const { harness, engines } = await setup();
		let on = true;
		engines.set(new FakeEngine(), () => on);
		const step = scripted([], (task, turn) => {
			if (turn === 0) {
				on = false;
				return fauxAssistantMessage([fauxToolCall(AGENTS_TOOL, { start: [{ label: "a", task: "x" }] })], {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage(`${task} ok`);
		});
		harness.setResponses(Array.from({ length: 2 }, () => step));
		await harness.session.prompt("go");
		const result = toolResult(harness);
		expect(result.isError).toBe(true);
		expect(text(result as Message)).toContain("Sub-agents are off");
	});
});

describe("ApprovalQueue", () => {
	it("runs one task at a time, also after a failure", async () => {
		const queue = new ApprovalQueue();
		const order: string[] = [];
		const task =
			(name: string, fail = false) =>
			async () => {
				order.push(`${name}:start`);
				await new Promise((resolve) => setTimeout(resolve, 5));
				order.push(`${name}:end`);
				if (fail) throw new Error(name);
				return name;
			};
		const results = await Promise.allSettled([queue.run(task("a", true)), queue.run(task("b"))]);
		expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
		expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
	});
});
