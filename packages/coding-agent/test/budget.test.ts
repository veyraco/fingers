/**
 * Task budgets (F16): `/budget` in the terminal app and managed RPC's `limits.max_cost_usd` share one enforcement
 * (core/budget.ts): the run ends after the turn whose model call reached the cap, and a new prompt is refused.
 */
import type { Agent, AgentTool } from "@veyraco/fingers-agent";
import {
	type AssistantMessageEventStream,
	calculateCost,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type Usage,
} from "@veyraco/fingers-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BUDGET_USAGE,
	budgetReachedText,
	costCapReached,
	endRunAfterTurnWhen,
	formatBudgetUsd,
	isListPriced,
	MAX_BUDGET_USD,
	parseBudgetCommand,
	SessionBudgetGuard,
	sessionUsageTotals,
	TaskBudget,
} from "../src/core/budget.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function usage(total: number): Usage {
	return {
		input: 100,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 110,
		cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
	};
}

describe("budget rules", () => {
	it("parses /budget arguments", () => {
		expect(parseBudgetCommand("")).toEqual({ kind: "show" });
		expect(parseBudgetCommand("   ")).toEqual({ kind: "show" });
		for (const word of ["off", "OFF", "none", "clear", "remove"])
			expect(parseBudgetCommand(word)).toEqual({ kind: "off" });
		expect(parseBudgetCommand("5")).toEqual({ kind: "set", capUsd: 5 });
		expect(parseBudgetCommand(" $2.50 ")).toEqual({ kind: "set", capUsd: 2.5 });
		expect(parseBudgetCommand("$ 0.75")).toEqual({ kind: "set", capUsd: 0.75 });
		expect(parseBudgetCommand(".5")).toEqual({ kind: "set", capUsd: 0.5 });
		expect(parseBudgetCommand("3 usd")).toEqual({ kind: "set", capUsd: 3 });
		expect(parseBudgetCommand("0")).toEqual({
			kind: "invalid",
			message: "A budget must be more than $0. Use /budget off to remove it.",
		});
		expect(parseBudgetCommand("-1")).toEqual({ kind: "invalid", message: BUDGET_USAGE });
		expect(parseBudgetCommand("5 dollars")).toEqual({ kind: "invalid", message: BUDGET_USAGE });
		expect(parseBudgetCommand("1e9")).toEqual({ kind: "invalid", message: BUDGET_USAGE });
		expect(parseBudgetCommand(String(MAX_BUDGET_USD + 1))).toEqual({
			kind: "invalid",
			message: "A budget can be at most $100,000.",
		});
	});

	it("stops at or above the cap, and only priced models count", () => {
		expect(costCapReached(4.99, 5)).toBe(false);
		expect(costCapReached(5, 5)).toBe(true);
		expect(costCapReached(5.01, 5)).toBe(true);
		expect(costCapReached(Number.NaN, 5)).toBe(false);
		expect(isListPriced({ cost: { input: 3, output: 15 } })).toBe(true);
		expect(isListPriced({ cost: { input: 0, output: 1 } })).toBe(true);
		expect(isListPriced({ cost: { input: 0, output: 0 } })).toBe(false);
		expect(isListPriced(undefined)).toBe(false);
	});

	it("keeps the cap and answers for a spend", () => {
		const budget = new TaskBudget();
		expect(budget.state(1)).toBeUndefined();
		expect(budget.reached(1_000)).toBe(false);
		budget.set(5);
		expect(budget.state(0.06)).toEqual({ spentUsd: 0.06, capUsd: 5 });
		expect(budget.reached(4.94)).toBe(false);
		expect(budget.reached(5)).toBe(true);
		budget.clear();
		expect(budget.capUsd).toBeUndefined();
		expect(() => budget.set(0)).toThrow(RangeError);
		expect(() => budget.set(MAX_BUDGET_USD + 1)).toThrow(RangeError);
		expect(formatBudgetUsd(0.004)).toBe("$0.004");
		expect(budgetReachedText(5.2, 5)).toBe(
			"Budget reached: $5.20 of $5.00 spent on this task. Raise it with /budget <dollars> or remove it with /budget off.",
		);
	});

	it("counts every model call the session recorded, summaries included", () => {
		const entries = [
			{ type: "message", message: { role: "assistant", usage: usage(1) } },
			{ type: "message", message: { role: "user", content: "hi" } },
			{ type: "message", message: { role: "toolResult", usage: usage(0.25) } },
			{ type: "message", message: { role: "toolResult" } },
			{ type: "usage", usage: usage(0.5) },
			{ type: "compaction", usage: usage(0.125) },
			{ type: "branch_summary", usage: usage(0.0625) },
			{ type: "compaction" },
		] as unknown as SessionEntry[];
		expect(sessionUsageTotals(entries).cost).toBe(1.9375);
	});

	it("ends the run after a turn only when asked, keeping the hook already there", async () => {
		const agent = { finishTurn: async () => ({ action: "continue" as const }) } as unknown as Agent;
		const original = agent.finishTurn;
		let stop = false;
		const restore = endRunAfterTurnWhen(agent, () => stop);
		const turn = {} as Parameters<NonNullable<Agent["finishTurn"]>>[0];
		expect(await agent.finishTurn?.(turn)).toEqual({ action: "continue" });
		stop = true;
		expect(await agent.finishTurn?.(turn)).toEqual({ action: "end" });
		restore();
		expect(agent.finishTurn).toBe(original);
	});
});

/** The faux provider reports no cost; price its usage at the model's list price like a real provider does. */
function withListPrices(harness: Harness): void {
	const inner = harness.session.agent.streamFunction;
	harness.session.agent.streamFunction = async (model, context, options) => {
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
	};
}

const noopTool: AgentTool = {
	name: "noop",
	label: "noop",
	description: "Does nothing.",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

describe("SessionBudgetGuard in a session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function session(cost = { input: 1_000, output: 1_000, cacheRead: 0, cacheWrite: 0 }) {
		const harness = await createHarness({ models: [{ id: "priced", cost }], tools: [noopTool] });
		harnesses.push(harness);
		withListPrices(harness);
		return harness;
	}

	/** The model calls the tool twice, then answers: three model calls without a budget. */
	function toolLoop(harness: Harness): void {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("noop", {}, { id: "call_1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("noop", {}, { id: "call_2" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
	}

	it("runs the whole task while the spend stays under the cap", async () => {
		const harness = await session();
		const guard = new SessionBudgetGuard(new TaskBudget(1_000));
		guard.attach(harness.session);
		toolLoop(harness);
		await harness.session.prompt("go");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(guard.spentUsd()).toBeGreaterThan(0);
		expect(guard.refusal()).toBeUndefined();
	});

	it("stops after the model call that reaches the cap: its tool call finishes, no further model call", async () => {
		const harness = await session();
		const reached: string[] = [];
		const guard = new SessionBudgetGuard(new TaskBudget(0.000_001), { onReached: (text) => reached.push(text) });
		guard.attach(harness.session);
		toolLoop(harness);
		await harness.session.prompt("go");
		// One model call, its tool result, then the stop: two responses never asked for.
		expect(harness.getPendingResponseCount()).toBe(2);
		const results = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(results).toHaveLength(1);
		const spent = guard.spentUsd();
		expect(spent).toBeGreaterThan(0.000_001);
		expect(reached).toEqual([budgetReachedText(spent, 0.000_001)]);
		expect(guard.refusal()).toBe(budgetReachedText(spent, 0.000_001));
		expect(guard.state()).toEqual({ spentUsd: spent, capUsd: 0.000_001 });

		// Raised: the task goes on.
		guard.budget.set(1_000);
		expect(guard.refusal()).toBeUndefined();
		await harness.session.prompt("go on");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("says once that a model without a list price cannot be stopped", async () => {
		const harness = await session({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		const unpriced: string[] = [];
		const guard = new SessionBudgetGuard(new TaskBudget(0.000_001), { onUnpriced: (text) => unpriced.push(text) });
		guard.attach(harness.session);
		toolLoop(harness);
		await harness.session.prompt("go");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(unpriced).toEqual([
			`No list price is known for ${harness.getModel().provider}/priced, so the budget cannot stop this task.`,
		]);
		expect(guard.refusal()).toBeUndefined();
	});

	it("moves to a replaced session and leaves the old agent as it was", async () => {
		const first = await session();
		const second = await session();
		const before = first.session.agent.finishTurn;
		const guard = new SessionBudgetGuard(new TaskBudget(0.000_001));
		guard.attach(first.session);
		expect(first.session.agent.finishTurn).not.toBe(before);
		guard.attach(second.session);
		expect(first.session.agent.finishTurn).toBe(before);
		// A new session is a new task: nothing spent yet.
		expect(guard.spentUsd()).toBe(0);
		expect(guard.refusal()).toBeUndefined();
		toolLoop(second);
		await second.session.prompt("go");
		expect(second.getPendingResponseCount()).toBe(2);
	});
});

describe("/budget in the terminal app", () => {
	type BudgetThis = {
		budgetGuard: SessionBudgetGuard;
		showStatus: (message: string) => void;
		showWarning: (message: string) => void;
		isExtensionCommand: (text: string) => boolean;
		ui: { requestRender: () => void };
	};
	const handleBudgetCommand = Reflect.get(InteractiveMode.prototype, "handleBudgetCommand") as (
		this: BudgetThis,
		argument: string,
	) => void;
	const refuseAtBudget = Reflect.get(InteractiveMode.prototype, "refuseAtBudget") as (
		this: BudgetThis,
		text: string,
	) => boolean;

	function mode(spent: number) {
		const status: string[] = [];
		const warnings: string[] = [];
		const guard = new SessionBudgetGuard();
		vi.spyOn(guard, "spentUsd").mockReturnValue(spent);
		const self: BudgetThis = {
			budgetGuard: guard,
			showStatus: (message) => status.push(message),
			showWarning: (message) => warnings.push(message),
			isExtensionCommand: (text) => text.startsWith("/ext"),
			ui: { requestRender: () => {} },
		};
		return { self, status, warnings, guard };
	}

	it("shows, sets and removes the budget", () => {
		const { self, status, warnings, guard } = mode(0.06);
		handleBudgetCommand.call(self, "");
		expect(status.pop()).toBe(`No budget is set. This task has spent $0.06. ${BUDGET_USAGE}`);
		handleBudgetCommand.call(self, " 5");
		expect(guard.budget.capUsd).toBe(5);
		expect(status.pop()).toBe(
			"Budget set: $5.00 for this task ($0.06 spent, $4.94 left). Fingers stops after the model call that reaches it.",
		);
		handleBudgetCommand.call(self, "");
		expect(status.pop()).toBe("Budget: $0.06 of $5.00 spent on this task, $4.94 left.");
		handleBudgetCommand.call(self, " lots");
		expect(warnings.pop()).toBe(BUDGET_USAGE);
		expect(guard.budget.capUsd).toBe(5);
		handleBudgetCommand.call(self, " off");
		expect(guard.budget.capUsd).toBeUndefined();
		expect(status.pop()).toBe("Budget removed. This task has spent $0.06.");
		handleBudgetCommand.call(self, " off");
		expect(status.pop()).toBe("No budget is set.");
	});

	it("warns when the new cap is already used up, and then refuses prompts but not extension commands", () => {
		const { self, warnings } = mode(0.06);
		expect(refuseAtBudget.call(self, "fix the bug")).toBe(false);
		handleBudgetCommand.call(self, " 0.05");
		expect(warnings.pop()).toBe(`Budget set to $0.05. ${budgetReachedText(0.06, 0.05)}`);
		expect(refuseAtBudget.call(self, "fix the bug")).toBe(true);
		expect(warnings.pop()).toBe(budgetReachedText(0.06, 0.05));
		expect(refuseAtBudget.call(self, "/ext do")).toBe(false);
		handleBudgetCommand.call(self, " 1");
		expect(refuseAtBudget.call(self, "fix the bug")).toBe(false);
	});
});
