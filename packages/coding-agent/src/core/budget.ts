/**
 * Cost budgets: the hard stop the terminal app's `/budget` and managed RPC's `limits.max_cost_usd` share.
 *
 * Both count the list-price cost of the model calls of a task, stop the run after the turn whose call reached the cap
 * (its tool calls still finish, no further model call is made), and refuse a new prompt while the cap is reached. A
 * model without a list price costs nothing as far as a budget can tell, so it cannot stop a task; both say so once.
 *
 * Budgets are core (MIT), not ee: the canvas shows `/budget` and the status line budget without sign-in, and the
 * Hands run limits (managed RPC keeps ee off) must use the same enforcement.
 */
import type { Agent, AgentTurnDecision } from "@veyraco/fingers-agent";
import type { AssistantMessage } from "@veyraco/fingers-ai";
import type { AgentSession, AgentSessionEvent } from "./agent-session.ts";
import type { SessionEntry } from "./session-manager.ts";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "./usage-totals.ts";

/** The most a budget may be set to, so a typo such as `/budget 50000000` is refused instead of meaning "no cap". */
export const MAX_BUDGET_USD = 100_000;

/** A model has a list price when either of its token prices is above zero. */
export function isListPriced(model: { cost?: { input?: number; output?: number } } | undefined): boolean {
	return Boolean(model?.cost && ((model.cost.input ?? 0) > 0 || (model.cost.output ?? 0) > 0));
}

/** The stop rule: the cap is reached once the spend is at or above it. */
export function costCapReached(spentUsd: number, capUsd: number): boolean {
	return Number.isFinite(spentUsd) && Number.isFinite(capUsd) && spentUsd >= capUsd;
}

/**
 * End the agent's run after a turn when `shouldEnd()` says so, keeping any finishTurn hook already on the agent. The
 * turn's tool calls have finished by then; the next model call is not made. Returns a function that puts the earlier
 * hook back.
 */
export function endRunAfterTurnWhen(agent: Agent, shouldEnd: () => boolean): () => void {
	const previous = agent.finishTurn;
	const finishTurn: NonNullable<Agent["finishTurn"]> = async (
		turn,
		signal,
	): Promise<AgentTurnDecision | undefined> => {
		const decision = (await previous?.(turn, signal)) ?? undefined;
		if (shouldEnd()) return { action: "end" };
		return decision;
	};
	agent.finishTurn = finishTurn;
	return () => {
		if (agent.finishTurn === finishTurn) agent.finishTurn = previous;
	};
}

/**
 * The usage of every model call recorded in a session's entries: assistant messages, usage entries, tool results that
 * carry a nested call's usage, and compaction and branch summaries. The status line's tokens and cost come from here.
 */
export function sessionUsageTotals(entries: readonly SessionEntry[]): UsageTotals {
	const totals = createUsageTotals();
	for (const entry of entries) {
		if (entry.type === "usage") {
			addUsageToTotals(totals, entry.usage);
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			addUsageToTotals(totals, entry.message.usage);
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			addUsageToTotals(totals, entry.message.usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			addUsageToTotals(totals, entry.usage);
		}
	}
	return totals;
}

/** What `/budget <argument>` asks for. */
type BudgetCommand =
	| { kind: "show" }
	| { kind: "off" }
	| { kind: "set"; capUsd: number }
	| { kind: "invalid"; message: string };

export const BUDGET_USAGE =
	"Usage: /budget <dollars> (e.g. /budget 5 or /budget $2.50), /budget off, or /budget to see it.";

const OFF_WORDS = new Set(["off", "none", "clear", "remove"]);
const AMOUNT = /^\$?\s*(\d+(?:\.\d+)?|\.\d+)\s*(?:usd)?$/i;

export function parseBudgetCommand(argument: string): BudgetCommand {
	const text = argument.trim();
	if (text === "") return { kind: "show" };
	if (OFF_WORDS.has(text.toLowerCase())) return { kind: "off" };
	const match = text.match(AMOUNT);
	if (!match) return { kind: "invalid", message: BUDGET_USAGE };
	const capUsd = Number(match[1]);
	if (!Number.isFinite(capUsd) || capUsd <= 0) {
		return { kind: "invalid", message: "A budget must be more than $0. Use /budget off to remove it." };
	}
	if (capUsd > MAX_BUDGET_USD) {
		return { kind: "invalid", message: `A budget can be at most $${MAX_BUDGET_USD.toLocaleString("en-US")}.` };
	}
	return { kind: "set", capUsd };
}

/** Dollars as the budget messages show them: two decimals, three below one cent. */
export function formatBudgetUsd(usd: number): string {
	return usd > 0 && usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

/** The line shown when a run stops at the cap, and when a prompt is refused because of it. */
export function budgetReachedText(spentUsd: number, capUsd: number): string {
	return `Budget reached: ${formatBudgetUsd(spentUsd)} of ${formatBudgetUsd(capUsd)} spent on this task. Raise it with /budget <dollars> or remove it with /budget off.`;
}

/**
 * The terminal app's task budget. The task is the session: the spend is what the session's model calls cost at list
 * price (the status line's cost), so a new session starts at $0 under the same cap. The budget only holds the cap; the
 * caller hands it the spend.
 */
export class TaskBudget {
	private cap: number | undefined;

	constructor(capUsd?: number) {
		if (capUsd !== undefined) this.set(capUsd);
	}

	get capUsd(): number | undefined {
		return this.cap;
	}

	set(capUsd: number): void {
		if (!Number.isFinite(capUsd) || capUsd <= 0 || capUsd > MAX_BUDGET_USD) {
			throw new RangeError(`Budget must be more than $0 and at most $${MAX_BUDGET_USD}.`);
		}
		this.cap = capUsd;
	}

	clear(): void {
		this.cap = undefined;
	}

	/** The status line's budget, or undefined without a cap. */
	state(spentUsd: number): { spentUsd: number; capUsd: number } | undefined {
		return this.cap === undefined ? undefined : { spentUsd, capUsd: this.cap };
	}

	reached(spentUsd: number): boolean {
		return this.cap !== undefined && costCapReached(spentUsd, this.cap);
	}
}

interface SessionBudgetGuardOptions {
	/** A run stopped at the cap (once per run). */
	onReached?(text: string): void;
	/** A model without a list price answered while a cap is set (once per model). */
	onUnpriced?(text: string): void;
}

/**
 * The terminal app's enforcement of a TaskBudget on the current session: it ends the run after the turn that reached
 * the cap, tells the caller once, and answers whether a new prompt must be refused. Attach it again after every
 * session replacement (new, resume, fork, clone, import): the new session has a new agent.
 */
export class SessionBudgetGuard {
	readonly budget: TaskBudget;
	private readonly options: SessionBudgetGuardOptions;
	private session: AgentSession | undefined;
	private restoreFinishTurn: (() => void) | undefined;
	private unsubscribe: (() => void) | undefined;
	private reachedThisRun = false;
	private readonly unpricedWarned = new Set<string>();

	constructor(budget: TaskBudget = new TaskBudget(), options: SessionBudgetGuardOptions = {}) {
		this.budget = budget;
		this.options = options;
	}

	attach(session: AgentSession): void {
		if (this.session === session) return;
		this.detach();
		this.session = session;
		this.restoreFinishTurn = endRunAfterTurnWhen(session.agent, () => this.stopAfterTurn());
		this.unsubscribe = session.subscribe((event) => this.onEvent(event));
	}

	detach(): void {
		this.restoreFinishTurn?.();
		this.restoreFinishTurn = undefined;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.session = undefined;
	}

	/** What the session's model calls cost so far, at list price. */
	spentUsd(): number {
		return this.session ? sessionUsageTotals(this.session.sessionManager.getEntries()).cost : 0;
	}

	/** The status line's budget, or undefined without a cap. */
	state(): { spentUsd: number; capUsd: number } | undefined {
		return this.budget.state(this.spentUsd());
	}

	/** The text to show instead of sending a prompt, or undefined when the prompt may go. */
	refusal(): string | undefined {
		const cap = this.budget.capUsd;
		if (cap === undefined) return undefined;
		const spent = this.spentUsd();
		return this.budget.reached(spent) ? budgetReachedText(spent, cap) : undefined;
	}

	private stopAfterTurn(): boolean {
		const cap = this.budget.capUsd;
		if (cap === undefined) return false;
		const spent = this.spentUsd();
		if (!this.budget.reached(spent)) return false;
		if (!this.reachedThisRun) {
			this.reachedThisRun = true;
			this.options.onReached?.(budgetReachedText(spent, cap));
		}
		return true;
	}

	private onEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			this.reachedThisRun = false;
			return;
		}
		if (event.type !== "message_end" || event.message.role !== "assistant") return;
		if (this.budget.capUsd === undefined) return;
		const message = event.message as AssistantMessage;
		const key = `${message.provider}/${message.model}`;
		if (this.unpricedWarned.has(key)) return;
		const model = this.session?.modelRuntime.getModel(message.provider, message.model);
		if (isListPriced(model)) return;
		this.unpricedWarned.add(key);
		this.options.onUnpriced?.(`No list price is known for ${key}, so the budget cannot stop this task.`);
	}
}
