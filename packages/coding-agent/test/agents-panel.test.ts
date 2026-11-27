/**
 * The sub-agents panel (canvas FingersTuiAgents) with a stand-in engine, rendered into a 120x36 virtual
 * terminal: the table, the models line, the selected sub-agent's last activity box and the key hints as on the
 * artboard; the keys act on the selected sub-agent (steer reaches the right one; approve lets its held question
 * through; pause, stop, checkpoint, resume from where it paused or from a checkpoint; open shows its transcript);
 * esc closes the panel and lets held questions through; the panel closes when sub-agents go off.
 */
import { tmpdir } from "node:os";
import { setKeybindings, TuiMainScreen } from "@veyraco/fingers-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { EditionGate } from "../src/core/edition/gate.ts";
import { EE_API_VERSION, type EeEntitlement, type EeModule } from "../src/core/edition/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SubagentEngines, subagentEngines } from "../src/core/subagents/registry.ts";
import type {
	SubagentCheckpoint,
	SubagentEngine,
	SubagentInfo,
	SubagentRunResult,
	SubagentTranscriptLine,
} from "../src/core/subagents/types.ts";
import {
	AgentsPanelComponent,
	agentStatusText,
	formatElapsed,
} from "../src/modes/interactive/components/agents-panel.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const COLUMNS = 120;
const ROWS = 36;
const NOW = new Date(2026, 10, 26, 12, 10, 0).getTime();
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";

beforeAll(() => {
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager());
});

function usage(tokens: number, cost: number): SubagentInfo["usage"] {
	return {
		input: tokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: tokens,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function agent(id: number, partial: Partial<SubagentInfo>): SubagentInfo {
	return {
		id: `sub_${id}`,
		parentId: "main",
		label: "agent",
		task: "task",
		kind: "code",
		dependsOn: [],
		status: "running",
		usage: usage(0, 0),
		model: { provider: "anthropic", id: "claude-haiku-4-5" },
		...partial,
	};
}

/** The artboard's five sub-agents. */
function canvasAgents(): SubagentInfo[] {
	return [
		agent(1, {
			label: "explorer",
			task: "Map every Stripe call in src/",
			status: "done",
			merged: true,
			filesChanged: 0,
			startedAt: NOW - 120_000,
			endedAt: NOW - 78_000,
			usage: usage(12_100, 0.01),
			summary: "Found 14 Stripe calls in 6 files.",
		}),
		agent(2, {
			label: "test-writer",
			task: "Write tests for the invoice webhook",
			startedAt: NOW - 130_000,
			usage: usage(8_400, 0.03),
		}),
		agent(3, {
			label: "migrator",
			task: "Port checkout to SDK v2",
			status: "waiting_approval",
			startedAt: NOW - 200_000,
			usage: usage(21_700, 0.09),
			activity: ["edit src/billing/checkout.ts"],
			pendingApproval: { command: "pnpm stripe:fixtures", reason: "Not in your allow list." },
			checkpoints: [
				{ id: "cp-6", at: new Date(2026, 10, 26, 12, 4).getTime(), filesChanged: 1 },
				{ id: "cp-7", at: new Date(2026, 10, 26, 12, 9).getTime(), filesChanged: 2 },
			],
		}),
		agent(4, {
			label: "migrator-2",
			task: "Port subscriptions to SDK v2",
			startedAt: NOW - 115_000,
			usage: usage(17_300, 0.07),
		}),
		agent(5, {
			label: "reviewer",
			task: "Review the diffs from 3 and 4",
			status: "queued",
			dependsOn: ["sub_3", "sub_4"],
		}),
	];
}

class StubEngine implements SubagentEngine {
	agents: SubagentInfo[] = canvasAgents();
	calls: string[] = [];
	transcripts: Record<string, SubagentTranscriptLine[]> = {};
	failResume?: string;

	async run(): Promise<SubagentRunResult> {
		throw new Error("not here");
	}
	steer(id: string, text: string): boolean {
		this.calls.push(`steer ${id} ${text}`);
		return true;
	}
	stop(id: string): boolean {
		this.calls.push(`stop ${id}`);
		return true;
	}
	list(): readonly SubagentInfo[] {
		return this.agents;
	}
	pause(id: string): boolean {
		this.calls.push(`pause ${id}`);
		const found = this.agents.find((candidate) => candidate.id === id);
		if (!found || found.status === "paused") return false;
		found.status = "paused";
		return true;
	}
	async resume(id: string, checkpoint?: string): Promise<void> {
		this.calls.push(`resume ${id}${checkpoint ? ` ${checkpoint}` : ""}`);
		if (this.failResume) throw new Error(this.failResume);
	}
	async checkpoint(id: string): Promise<SubagentCheckpoint> {
		this.calls.push(`checkpoint ${id}`);
		return { id: "cp-8", at: NOW, filesChanged: 3 };
	}
	transcript(id: string): SubagentTranscriptLine[] | undefined {
		return this.transcripts[id];
	}
	async removeWorktree(id: string): Promise<void> {
		this.calls.push(`remove ${id}`);
	}
}

function setup(engine: SubagentEngine = new StubEngine(), on = true) {
	const engines = new SubagentEngines();
	let isOn = on;
	engines.set(engine, () => isOn);
	let closed = 0;
	let renders = 0;
	const panel = new AgentsPanelComponent({
		engines,
		parentModel: "claude-sonnet-4-5",
		task: "Migrate billing to Stripe SDK v2",
		onClose: () => closed++,
		requestRender: () => renders++,
		now: () => NOW,
		tickMs: 0,
	});
	return {
		panel,
		engines,
		closed: () => closed,
		renders: () => renders,
		turnOff: () => {
			isOn = false;
			engines.set(engine, () => isOn);
		},
	};
}

async function renderScreen(panel: AgentsPanelComponent): Promise<string[]> {
	const terminal = new VirtualTerminal(COLUMNS, ROWS);
	const tui = new TuiMainScreen(terminal);
	tui.addChild(panel);
	tui.start();
	tui.renderNow();
	const viewport = await terminal.flushAndGetViewport();
	tui.stop();
	return viewport.map((line) => line.trimEnd());
}

/** The plain text of each line (colors and the input's cursor markers removed). */
function lines(panel: AgentsPanelComponent, width = COLUMNS): string[] {
	return panel.render(width).map((line) => stripAnsi(line.replace(/\x1b_[^\x07]*\x07/g, "")).trimEnd());
}

/** Every expected line appears, in order. A string must equal the trimmed line; a RegExp must match it. */
function expectInOrder(actual: string[], expected: Array<string | RegExp>): void {
	let from = 0;
	for (const want of expected) {
		const index = actual.findIndex(
			(line, i) => i >= from && (typeof want === "string" ? line.trim() === want : want.test(line)),
		);
		if (index === -1) throw new Error(`missing ${String(want)} after line ${from} in:\n${actual.join("\n")}`);
		from = index + 1;
	}
}

describe("the sub-agents panel", () => {
	it("draws the artboard's table, models line, activity box and keys at 120x36", async () => {
		const { panel } = setup();
		panel.handleInput(DOWN);
		panel.handleInput(DOWN);
		const screen = await renderScreen(panel);
		expect(panel.render(COLUMNS).length).toBeLessThanOrEqual(ROWS);
		expectInOrder(screen, [
			"Sub-agents  ·  task: Migrate billing to Stripe SDK v2  ·  3 running · 1 done · 1 queued",
			"Parallel, each in its own git worktree · checkpoints are git commits kept in this session",
			"#  agent        task                                  status                    tokens     cost",
			/^ {2}─{100}$/,
			"1  explorer     Map every Stripe call in src/         ✓ done · 0:42              12.1k    $0.01",
			"2  test-writer  Write tests for the invoice webhook   ● running · 2:10            8.4k    $0.03",
			"❯  3  migrator     Port checkout to SDK v2               ‖ waiting for approval     21.7k    $0.09",
			"4  migrator-2   Port subscriptions to SDK v2          ● running · 1:55           17.3k    $0.07",
			"5  reviewer     Review the diffs from 3 and 4         ○ queued · needs 3, 4          —        —",
			/^ {2}─{100}$/,
			"sub-tasks use a cheaper model: claude-haiku-4-5   ·   parent: claude-sonnet-4-5   ·   total $0.20",
			/^╭─ #3 migrator · last activity ─+╮$/,
			/^│ ● edit src\/billing\/checkout\.ts +│$/,
			/^│ ● Wants to run pnpm stripe:fixtures {2}\(Not in your allow list\.\) +│$/,
			/^│ checkpoints {2}cp-6 12:04 {2}· {2}cp-7 12:09 {2}· {2}pause it, then r resumes from any of them +│$/,
			/^╰─+╯$/,
			"enter open · a approve · s steer · p pause · k stop · c checkpoint · r resume · esc back",
		]);
	});

	it("says what to do when there are no sub-agents yet", () => {
		const engine = new StubEngine();
		engine.agents = [];
		const { panel, closed } = setup(engine);
		expectInOrder(lines(panel), [
			"No sub-agents yet in this session.",
			"Ask for work that splits into independent parts; the agent starts sub-agents with its agents tool.",
			"esc back",
		]);
		panel.handleInput("p");
		expect(engine.calls).toEqual([]);
		panel.handleInput(ESC);
		expect(closed()).toBe(1);
	});

	it("steers the selected sub-agent, and only that one", () => {
		const engine = new StubEngine();
		const { panel } = setup(engine);
		panel.handleInput(DOWN);
		panel.handleInput(DOWN);
		panel.handleInput(DOWN);
		panel.handleInput(UP);
		panel.handleInput("s");
		expect(panel.currentMode).toBe("steer");
		for (const char of "use the existing createPaymentIntent helper") panel.handleInput(char);
		expect(lines(panel)).toContain("steer #3 › use the existing createPaymentIntent helper");
		panel.handleInput(ENTER);
		expect(engine.calls).toEqual(["steer sub_3 use the existing createPaymentIntent helper"]);
		expect(panel.currentMode).toBe("list");
		expect(lines(panel)).toContain("Sent to #3; it reads it before its next model call.");
		// An ended or queued one cannot be steered.
		panel.handleInput(UP);
		panel.handleInput(UP);
		panel.handleInput("s");
		expect(panel.currentMode).toBe("list");
		expect(lines(panel)).toContain("#1 is not running, so it cannot be steered.");
	});

	it("holds children's approval questions while open; a lets the selected one's question through; esc lets all through", async () => {
		const engine = new StubEngine();
		const { panel, engines, closed } = setup(engine);
		const passed: string[] = [];
		void engines.approvals.turn("sub_3").then(() => passed.push("sub_3"));
		void engines.approvals.turn("sub_4").then(() => passed.push("sub_4"));
		await Promise.resolve();
		expect(passed).toEqual([]);
		panel.handleInput(DOWN);
		panel.handleInput(DOWN);
		expect(lines(panel)).toContainEqual(expect.stringMatching(/a opens the approval box/));
		panel.handleInput("a");
		await Promise.resolve();
		expect(passed).toEqual(["sub_3"]);
		panel.handleInput(DOWN);
		panel.handleInput(UP);
		panel.handleInput("a");
		expect(lines(panel)).toContain("#3's approval box is already open; answer it first.");
		panel.handleInput(UP);
		panel.handleInput("a");
		expect(lines(panel)).toContain("#2 is not waiting for an approval.");
		panel.handleInput(ESC);
		await Promise.resolve();
		expect(closed()).toBe(1);
		expect(passed).toEqual(["sub_3", "sub_4"]);
		// Without the panel, questions go through at once.
		await engines.approvals.turn("sub_5");
	});

	it("pauses, stops and keeps a checkpoint of the selected sub-agent", async () => {
		const engine = new StubEngine();
		const { panel } = setup(engine);
		panel.handleInput(DOWN);
		panel.handleInput("p");
		expect(lines(panel)).toContain("Pausing #2: it holds before its next model call.");
		expect(lines(panel)).toContainEqual(expect.stringMatching(/2 {2}test-writer .*‖ paused · 2:10/));
		panel.handleInput("p");
		expect(lines(panel)).toContain("#2 is paused already.");
		panel.handleInput("c");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(lines(panel)).toContain("Kept cp-8 of #2 (3 files changed).");
		panel.handleInput(DOWN);
		panel.handleInput("k");
		expect(engine.calls).toEqual(["pause sub_2", "pause sub_2", "checkpoint sub_2", "stop sub_3"]);
	});

	it("resumes from where it paused, or from a checkpoint picked in the list", async () => {
		const engine = new StubEngine();
		const { panel } = setup(engine);
		panel.handleInput(DOWN);
		panel.handleInput("r");
		expect(lines(panel)).toContain("#2 is not paused; p pauses it.");
		panel.handleInput("p");
		panel.handleInput("r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(engine.calls.at(-1)).toBe("resume sub_2");
		expect(lines(panel)).toContain("#2 goes on.");

		panel.handleInput(DOWN);
		engine.agents[2]!.status = "paused";
		panel.handleInput("r");
		expect(panel.currentMode).toBe("pick");
		expectInOrder(lines(panel), [
			/^╭─ Resume #3 migrator from ─+╮$/,
			/^│ ❯ where it paused +│$/,
			/^│ {3}cp-7 · 12:09 · 2 files changed +│$/,
			/^│ {3}cp-6 · 12:04 · 1 files changed +│$/,
			"↑↓ choose · enter resume · esc back",
		]);
		panel.handleInput(DOWN);
		panel.handleInput(ENTER);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(engine.calls.at(-1)).toBe("resume sub_3 cp-7");
		expect(lines(panel)).toContain("#3 goes on from cp-7.");
		engine.failResume = "Could not resume sub_3 from cp-6: boom";
		panel.handleInput("r");
		panel.handleInput(UP);
		panel.handleInput(ENTER);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(engine.calls.at(-1)).toBe("resume sub_3 cp-6");
		expect(lines(panel)).toContain("Could not resume sub_3 from cp-6: boom");
		panel.handleInput("r");
		panel.handleInput(ESC);
		expect(panel.currentMode).toBe("list");
	});

	it("opens the selected sub-agent's transcript and scrolls it", () => {
		const engine = new StubEngine();
		engine.transcripts.sub_1 = [
			{ kind: "task", text: "Map every Stripe call in src/" },
			{ kind: "tool", text: "grep stripe\\." },
			{ kind: "tool_result", text: "src/billing/checkout.ts:12: stripe.charges.create(" },
			...Array.from({ length: 30 }, (_, index) => ({ kind: "assistant" as const, text: `line ${index + 1}` })),
		];
		const { panel, closed } = setup(engine);
		panel.handleInput(ENTER);
		expect(panel.currentMode).toBe("open");
		let shown = lines(panel);
		expect(shown).toContainEqual(expect.stringMatching(/^╭─ #1 explorer · ✓ done · 0:42 ─+╮$/));
		expect(shown).toContainEqual(expect.stringMatching(/^│ line 30 +│$/));
		expect(shown).not.toContainEqual(expect.stringMatching(/Map every Stripe call/));
		expect(shown.at(-1)).toBe("  ↑↓ scroll · esc back");
		for (let i = 0; i < 40; i++) panel.handleInput(UP);
		shown = lines(panel);
		expect(shown).toContainEqual(expect.stringMatching(/^│ › Map every Stripe call in src\/ +│$/));
		expect(shown).toContainEqual(expect.stringMatching(/^│ → grep stripe\\\. +│$/));
		panel.handleInput(ESC);
		expect(panel.currentMode).toBe("list");
		expect(closed()).toBe(0);
	});

	it("offers to remove a kept worktree", async () => {
		const engine = new StubEngine();
		engine.agents[0] = { ...engine.agents[0]!, status: "failed", keptWorktree: ".fingers/worktrees/sub_1" };
		const { panel } = setup(engine);
		expect(lines(panel)).toContainEqual(
			expect.stringMatching(/worktree {2}\.fingers\/worktrees\/sub_1 {2}· {2}x removes it/),
		);
		panel.handleInput("x");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(engine.calls).toEqual(["remove sub_1"]);
		expect(lines(panel)).toContain("Removed the worktree #1 kept.");
	});

	it("closes when sub-agents go off, and redraws on the engine's events", () => {
		const { panel, engines, closed, renders, turnOff } = setup();
		const before = renders();
		engines.emit({ type: "subagent_updated", agent: canvasAgents()[1]! });
		expect(renders()).toBe(before + 1);
		turnOff();
		expect(closed()).toBe(1);
		panel.handleInput(ESC);
		expect(closed()).toBe(1);
	});
});

describe("/agents in the terminal app", () => {
	const MEDIUM: EeEntitlement = {
		signedIn: true,
		source: "connect",
		org: "org_1",
		orgName: "Acme Robotics",
		tier: "medium",
		fingersEnabled: true,
		checkedAt: Date.now(),
	};
	/** A stand-in ee module whose /agents opens the panel when the terminal app offers one. */
	const eeModule = (): EeModule => ({
		apiVersion: EE_API_VERSION,
		matrixVersion: "test.1",
		minimumTier: () => "medium",
		activate: (host) => {
			if (host.isOn("subagents")) {
				host.registerCommand("agents", (context) => {
					if (context.openAgentsPanel) context.openAgentsPanel();
					else context.showStatus("no panel");
				});
			}
		},
	});

	it("opens the panel in place of the editor with the parent's model and last prompt, once at a time", async () => {
		const gate = new EditionGate({ loadModule: async () => eeModule() });
		await gate.setEntitlement(MEDIUM);
		const engine = new StubEngine();
		subagentEngines.set(engine, () => true);
		const opened: { panel: AgentsPanelComponent; done: () => void }[] = [];
		const instance = Object.create(InteractiveMode.prototype) as Record<string, any>;
		Object.assign(instance, {
			editionGate: gate,
			agentsPanelOpen: false,
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
			runtimeHost: {
				session: {
					sessionManager: { getCwd: () => tmpdir() },
					model: { id: "claude-sonnet-4-5" },
					getUserMessagesForForking: () => [
						{ entryId: "1", text: "first" },
						{ entryId: "2", text: "Migrate billing" },
					],
				},
			},
			showExtensionCustom: vi.fn(
				(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => unknown) =>
					new Promise<void>((resolve) => {
						const done = () => resolve();
						const panel = factory(
							{ requestRender: () => {} },
							undefined,
							undefined,
							done,
						) as AgentsPanelComponent;
						opened.push({ panel, done });
					}),
			),
		});
		try {
			await instance.handleEeCommand("agents", "");
			await instance.handleEeCommand("agents", "");
			expect(instance.showExtensionCustom).toHaveBeenCalledTimes(1);
			expect(instance.showStatus).not.toHaveBeenCalled();
			const { panel } = opened[0]!;
			expect(panel).toBeInstanceOf(AgentsPanelComponent);
			const shown = lines(panel);
			expect(shown[0]).toBe("Sub-agents  ·  task: Migrate billing  ·  3 running · 1 done · 1 queued");
			expect(shown).toContainEqual(expect.stringContaining("parent: claude-sonnet-4-5"));
			// esc closes it; then /agents opens it again.
			panel.handleInput(ESC);
			await vi.waitFor(() => expect(instance.agentsPanelOpen).toBe(false));
			await instance.handleEeCommand("agents", "");
			expect(instance.showExtensionCustom).toHaveBeenCalledTimes(2);
			opened[1]!.panel.close();
		} finally {
			subagentEngines.clear();
		}
	});
});

describe("panel texts", () => {
	it("formats elapsed time and every status", () => {
		expect(formatElapsed(42_000)).toBe("0:42");
		expect(formatElapsed(130_000)).toBe("2:10");
		expect(formatElapsed(3_725_000)).toBe("1:02:05");
		const base = agent(1, { startedAt: NOW - 10_000, endedAt: NOW });
		expect(agentStatusText({ ...base, status: "done", merged: false }, NOW).text).toBe("✓ done, not merged · 0:10");
		expect(agentStatusText({ ...base, status: "failed" }, NOW).text).toBe("✗ failed · 0:10");
		expect(agentStatusText({ ...base, status: "stopped" }, NOW).text).toBe("■ stopped · 0:10");
		expect(agentStatusText({ ...base, status: "queued", startedAt: undefined, endedAt: undefined }, NOW).text).toBe(
			"○ queued",
		);
	});
});
