/**
 * Sub-agent control (F19, open core): real child sessions on the faux provider, driven the way the `/agents` panel
 * drives them through an engine. Pause holds a child before its next model call and resume lets it go on with its
 * transcript as it was; atRest runs at a point where every step has its result; rollBack takes a held child's
 * transcript back to such a point and it goes on with a note; while the approval desk holds questions, a child's
 * question waits (shown as waiting, with the question) until it is let through; each step is reported as activity.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@veyraco/fingers-ai";
import { fauxAssistantMessage, fauxToolCall } from "@veyraco/fingers-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SubagentApprovalDesk, SubagentEngines } from "../src/core/subagents/registry.ts";
import type {
	SubagentApprovalRequest,
	SubagentCheckpoint,
	SubagentChild,
	SubagentEngine,
	SubagentInfo,
	SubagentRunHost,
	SubagentRunRequest,
	SubagentRunResult,
	SubagentTranscriptLine,
} from "../src/core/subagents/types.ts";
import { emptyUsage } from "../src/core/subagents/types.ts";
import type { AskForApproval } from "../src/extensions/approvals/index.ts";
import { toolStepText } from "../src/extensions/subagents/child-session.ts";
import { AGENTS_TOOL, createSubagentsExtension } from "../src/extensions/subagents/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function text(message: Message | undefined): string {
	if (!message || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** An engine that runs each child of a call at once in `<cwd>/w-<label>` and keeps the child objects for the test. */
class ControlEngine implements SubagentEngine {
	readonly children = new Map<string, SubagentChild>();
	readonly approvals: { id: string; waiting: boolean; request?: SubagentApprovalRequest }[] = [];
	readonly activity: { id: string; line: string }[] = [];

	async run(request: SubagentRunRequest, host: SubagentRunHost): Promise<SubagentRunResult> {
		const agents = await Promise.all(
			request.agents.map(async (spec, index): Promise<SubagentInfo> => {
				const id = `sub_${index + 1}`;
				const cwd = join(host.cwd, `w-${spec.label}`);
				mkdirSync(cwd, { recursive: true });
				const model = host.pickModel("code");
				const child = await host.startChild({
					id,
					label: spec.label,
					task: spec.task,
					cwd,
					...(model ? { model } : {}),
				});
				this.children.set(id, child);
				child.onApproval((waiting, question) => this.approvals.push({ id, waiting, request: question }));
				child.onActivity((line) => this.activity.push({ id, line }));
				const outcome = await child.run();
				const usage = child.usage();
				child.dispose();
				return {
					id,
					parentId: "main",
					label: spec.label,
					task: spec.task,
					kind: "code",
					dependsOn: [],
					status: outcome.status,
					usage,
					summary: outcome.summary,
				};
			}),
		);
		return { agents, usage: emptyUsage(), text: agents.map((agent) => `${agent.id}: ${agent.summary}`).join("\n") };
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
		throw new Error("not here");
	}
	transcript(): SubagentTranscriptLine[] | undefined {
		return undefined;
	}
	async removeWorktree(): Promise<void> {}
}

interface ChildCall {
	turn: number;
	messages: Message[];
}

async function setup(ask?: AskForApproval) {
	const engines = new SubagentEngines();
	const engine = new ControlEngine();
	engines.set(engine, () => true);
	const agentDir = mkdtempSync(join(tmpdir(), "fingers-subagents-agent-"));
	dirs.push(agentDir);
	const harness = await createHarness({
		extensionFactories: [{ name: "subagents", factory: createSubagentsExtension({ engines, agentDir, ask }) }],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });
	return { harness, engines, engine };
}

/**
 * The parent starts one child "w" with `task`; the child's calls go to `child(turn, messages)`; the parent then ends.
 */
function steps(
	task: string,
	childCalls: ChildCall[],
	child: (turn: number, messages: Message[]) => ReturnType<typeof fauxAssistantMessage>,
) {
	return (context: { messages: Message[] }) => {
		const system = JSON.stringify(context.messages.filter((message) => message.role === "system"));
		const turn = context.messages.filter((message) => message.role === "assistant").length;
		if (!system.includes("You are sub-agent sub_")) {
			return turn === 0
				? fauxAssistantMessage([fauxToolCall(AGENTS_TOOL, { start: [{ label: "w", task }] })], {
						stopReason: "toolUse",
					})
				: fauxAssistantMessage("Parent done.");
		}
		const messages = context.messages.filter((message) => message.role !== "system");
		childCalls.push({ turn, messages });
		return child(turn, messages);
	};
}

/** Waits until `condition` holds (at most 10 s). */
async function until(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const pauseHere = (child: SubagentChild) =>
	child.atRest(async (position) => {
		child.pause();
		return position;
	});

describe("sub-agent control on real child sessions", () => {
	it("pause holds a child before its next model call; resume goes on with the transcript as it was", async () => {
		const { harness, engine } = await setup();
		const calls: ChildCall[] = [];
		const at: { held?: Promise<string | null> } = {};
		const step = steps("Write a.txt and b.txt", calls, (turn) => {
			const child = engine.children.get("sub_1")!;
			if (turn === 0) {
				// Held at the next model call, after this step's write has its result.
				at.held = pauseHere(child);
				return fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "a\n" })], {
					stopReason: "toolUse",
				});
			}
			if (turn === 1) {
				return fauxAssistantMessage([fauxToolCall("write", { path: "b.txt", content: "b\n" })], {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage("Wrote both.");
		});
		harness.setResponses(Array.from({ length: 5 }, () => step));
		const run = harness.session.prompt("go");

		await until(() => at.held !== undefined);
		const position = await at.held!;
		const child = engine.children.get("sub_1")!;
		const workdir = join(harness.tempDir, "w-w");
		expect(existsSync(join(workdir, "a.txt"))).toBe(true);
		// Paused: no model call while held, also after a while.
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(calls).toHaveLength(1);
		expect(existsSync(join(workdir, "b.txt"))).toBe(false);
		expect(position).not.toBeNull();
		const before = child.transcript();
		expect(before.map((line) => line.kind)).toEqual(["task", "tool", "tool_result"]);
		expect(before[1]!.text).toBe("write a.txt");
		expect(child.pause()).toBe(false);

		expect(child.resume()).toBe(true);
		expect(child.resume()).toBe(false);
		await run;
		expect(calls).toHaveLength(3);
		// The call after the pause saw the whole transcript from before it.
		expect(calls[1]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(text(calls[1]!.messages[0])).toBe("Write a.txt and b.txt");
		const after = engine.activity.map((entry) => entry.line);
		expect(after).toEqual(["write a.txt", "write b.txt"]);
		expect(existsSync(join(workdir, "b.txt"))).toBe(true);
	});

	it("rolls a held child back to a checkpoint position: what came after is gone and it goes on with the note", async () => {
		const { harness, engine } = await setup();
		const calls: ChildCall[] = [];
		const at: { checkpoint?: Promise<string | null>; laterHold?: Promise<string | null> } = {};
		const step = steps("Write a.txt, then b.txt", calls, (turn, messages) => {
			const child = engine.children.get("sub_1")!;
			if (turn === 0) {
				// The checkpoint: the point before the next model call (a.txt written and answered).
				at.checkpoint = child.atRest(async (position) => position);
				return fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "a\n" })], {
					stopReason: "toolUse",
				});
			}
			const last = messages.at(-1);
			if (last?.role === "user" && text(last).startsWith("ROLLED BACK"))
				return fauxAssistantMessage("Back on track.");
			if (turn === 1) {
				at.laterHold = pauseHere(child);
				return fauxAssistantMessage([fauxToolCall("write", { path: "b.txt", content: "b\n" })], {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage("Should not get here.");
		});
		harness.setResponses(Array.from({ length: 6 }, () => step));
		const run = harness.session.prompt("go");

		await until(() => at.checkpoint !== undefined);
		const position = await at.checkpoint!;
		await until(() => at.laterHold !== undefined);
		await at.laterHold;
		const child = engine.children.get("sub_1")!;
		const workdir = join(harness.tempDir, "w-w");
		expect(
			child
				.transcript()
				.filter((line) => line.kind === "tool")
				.map((line) => line.text),
		).toEqual(["write a.txt", "write b.txt"]);

		let prepared = 0;
		await child.rollBack(position, "ROLLED BACK", async () => {
			prepared++;
			rmSync(join(workdir, "b.txt"));
		});
		expect(prepared).toBe(1);
		await run;

		const last = calls.at(-1)!;
		// The call after the roll-back: the transcript up to the checkpoint plus the note, without the b.txt step.
		expect(last.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
		expect(text(last.messages[3])).toBe("ROLLED BACK");
		expect(JSON.stringify(last.messages.slice(1))).not.toContain("b.txt");
		expect(
			child
				.transcript()
				.filter((line) => line.kind === "tool")
				.map((line) => line.text),
		).toEqual(["write a.txt"]);
		expect(existsSync(join(workdir, "b.txt"))).toBe(false);
		const result = harness.session.messages.findLast(
			(message) => message.role === "toolResult" && message.toolName === AGENTS_TOOL,
		);
		expect(text(result)).toBe("sub_1: Back on track.");
	});

	it("rolls back to before the first model call: the task is sent again with the note", async () => {
		const { harness, engine } = await setup();
		const calls: ChildCall[] = [];
		const at: { first?: Promise<string | null>; hold?: Promise<string | null> } = {};
		const step = steps("Do the thing", calls, (turn, messages) => {
			const child = engine.children.get("sub_1")!;
			if (messages.length === 1 && text(messages[0]).includes("AGAIN")) return fauxAssistantMessage("Done again.");
			if (turn === 0) {
				at.hold = pauseHere(child);
				return fauxAssistantMessage([fauxToolCall("write", { path: "x.txt", content: "x\n" })], {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage("unexpected");
		});
		harness.setResponses(Array.from({ length: 5 }, () => step));
		const original = engine.run.bind(engine);
		engine.run = async (request, host) =>
			original(request, {
				...host,
				startChild: async (options) => {
					const child = await host.startChild(options);
					// Its first gate: before its first model call.
					at.first = child.atRest(async (position) => position);
					return child;
				},
			});
		const run = harness.session.prompt("go");
		await until(() => at.first !== undefined);
		const position = await at.first!;
		await until(() => at.hold !== undefined);
		await at.hold;
		const child = engine.children.get("sub_1")!;
		await child.rollBack(position, "AGAIN", async () => {});
		await run;
		const last = calls.at(-1)!;
		expect(last.messages).toHaveLength(1);
		expect(text(last.messages[0])).toBe("Do the thing\n\nAGAIN");
	});

	it("refuses a roll-back unless the child is paused, and atRest after it ended", async () => {
		const { harness, engine } = await setup();
		const calls: ChildCall[] = [];
		const step = steps("Answer", calls, () => fauxAssistantMessage("Answered."));
		harness.setResponses(Array.from({ length: 3 }, () => step));
		const seen: { refused?: string } = {};
		const original = engine.run.bind(engine);
		engine.run = async (request, host) =>
			original(request, {
				...host,
				startChild: async (options) => {
					const child = await host.startChild(options);
					await child
						.rollBack(null, "x", async () => {})
						.catch((error: Error) => {
							seen.refused = error.message;
						});
					return child;
				},
			});
		await harness.session.prompt("go");
		expect(seen.refused).toBe("sub_1 is not paused.");
		const child = engine.children.get("sub_1")!;
		await expect(child.atRest(async () => 1)).rejects.toThrow("sub_1 is not running.");
		expect(child.pause()).toBe(false);
	});

	it("keeps a child's approval question on the desk while it is held, shown as waiting with the question", async () => {
		const asked: string[] = [];
		const ask: AskForApproval = async (_ctx, request) => {
			asked.push(request.command);
			return { decision: "allow_once" };
		};
		const { harness, engines, engine } = await setup(ask);
		const calls: ChildCall[] = [];
		const step = steps("Clean", calls, (turn) =>
			turn === 0
				? fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf build-x" })], { stopReason: "toolUse" })
				: fauxAssistantMessage("Cleaned."),
		);
		harness.setResponses(Array.from({ length: 4 }, () => step));
		const release = engines.approvals.hold();
		const run = harness.session.prompt("go");
		await until(() => engines.approvals.isHeld("sub_1"));
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(asked).toEqual([]);
		expect(engine.approvals).toEqual([
			{ id: "sub_1", waiting: true, request: { command: "rm -rf build-x", reason: expect.any(String) } },
		]);
		expect(engines.approvals.release("sub_2")).toBe(false);
		expect(engines.approvals.release("sub_1")).toBe(true);
		await run;
		release();
		expect(asked).toEqual(["rm -rf build-x"]);
		expect(engine.approvals.map((entry) => entry.waiting)).toEqual([true, false]);
		expect(engine.activity).toEqual([{ id: "sub_1", line: "bash rm -rf build-x" }]);
	});
});

describe("a held question of a child that stops", () => {
	it("is dropped from the desk and never asked", async () => {
		const asked: string[] = [];
		const ask: AskForApproval = async (_ctx, request) => {
			asked.push(request.command);
			return { decision: "allow_once" };
		};
		const { harness, engines, engine } = await setup(ask);
		const calls: ChildCall[] = [];
		const step = steps("Clean", calls, (turn) =>
			turn === 0
				? fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf build-y" })], { stopReason: "toolUse" })
				: fauxAssistantMessage("Cleaned."),
		);
		harness.setResponses(Array.from({ length: 4 }, () => step));
		const release = engines.approvals.hold();
		const run = harness.session.prompt("go");
		await until(() => engines.approvals.isHeld("sub_1"));
		engine.children.get("sub_1")!.abort();
		await run;
		release();
		expect(asked).toEqual([]);
		expect(engines.approvals.isHeld("sub_1")).toBe(false);
		expect(engines.approvals.release("sub_1")).toBe(false);
	});
});

describe("the approval desk", () => {
	it("lets questions through at once without a holder, holds them while held, and lets all through on release", async () => {
		const desk = new SubagentApprovalDesk();
		await desk.turn("sub_1");
		const releaseA = desk.hold();
		const releaseB = desk.hold();
		const passed: string[] = [];
		void desk.turn("sub_1").then(() => passed.push("sub_1"));
		void desk.turn("sub_2").then(() => passed.push("sub_2"));
		void desk.turn("sub_2").then(() => passed.push("sub_2 again"));
		await Promise.resolve();
		expect(passed).toEqual([]);
		expect(desk.isHeld("sub_2")).toBe(true);
		expect(desk.release("sub_2")).toBe(true);
		await Promise.resolve();
		expect(passed).toEqual(["sub_2"]);
		releaseA();
		releaseA();
		await Promise.resolve();
		expect(passed).toEqual(["sub_2"]);
		releaseB();
		await Promise.resolve();
		expect(passed.sort()).toEqual(["sub_1", "sub_2", "sub_2 again"]);
		expect(desk.isHeld("sub_1")).toBe(false);

		// A question whose child stops leaves the desk.
		const releaseC = desk.hold();
		const controller = new AbortController();
		let through = false;
		const waiting = desk.turn("sub_3", controller.signal).then(() => {
			through = true;
		});
		expect(desk.isHeld("sub_3")).toBe(true);
		controller.abort();
		await waiting;
		expect(through).toBe(true);
		expect(desk.isHeld("sub_3")).toBe(false);
		await desk.turn("sub_3", controller.signal);
		releaseC();
	});
});

describe("toolStepText", () => {
	it("names a step by its tool and its main argument, on one line", () => {
		expect(toolStepText("edit", { path: "src/a.ts", oldText: "x" })).toBe("edit src/a.ts");
		expect(toolStepText("bash", { command: "pnpm\ntest\u001b[31m" })).toBe("bash pnpm test [31m");
		expect(toolStepText("ls", {})).toBe("ls");
	});
});
