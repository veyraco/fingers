/**
 * Sub-agents (open core, MIT): the shapes the core and a sub-agent engine share. The engine is an ee feature
 * (`ee/src/subagents`, tier Medium): it plans the children of one `agents` tool call, gives each its own git worktree,
 * runs them in parallel (a child with dependencies waits for them), and merges what a finished child changed into the
 * parent's working tree. The core offers the `agents` tool (core/subagents/extension.ts), makes the child sessions
 * (child-session.ts: same credentials, the parent's settings and approvals) and keeps the engine that is live
 * (registry.ts). Without an engine (core only, signed out, a tier without sub-agents, managed RPC, print and JSON
 * modes) the tool is not offered.
 *
 * Statuses and the lifecycle follow the Fingers RPC v1 contract (veyraco/platform contracts/v1/fingers-rpc.md,
 * `subagent_started`, `subagent_updated`, `subagent_finished`): a host or a panel can map them one to one.
 */
import type { Usage } from "@veyraco/fingers-ai";

/** Fingers RPC v1 `subagentStatus`. */
export const SUBAGENT_STATUSES = [
	"queued",
	"running",
	"waiting_approval",
	"paused",
	"done",
	"failed",
	"stopped",
] as const;
export type SubagentStatus = (typeof SUBAGENT_STATUSES)[number];

/** The statuses a sub-agent ends in. */
export type SubagentEndStatus = Extract<SubagentStatus, "done" | "failed" | "stopped">;

/**
 * What kind of work a child does, which decides the model it runs on: `search` (look things up: the cheapest model
 * that fits), `review` and `code` (check or change code: the strongest cheaper model, routed with the review rule).
 */
export const SUBAGENT_KINDS = ["code", "search", "review"] as const;
export type SubagentKind = (typeof SUBAGENT_KINDS)[number];

/** Limits of one `agents` call. */
export const MAX_SUBAGENTS_PER_CALL = 8;
export const MAX_SUBAGENT_LABEL_CHARS = 80;
export const MAX_SUBAGENT_TASK_CHARS = 4_000;
export const MAX_SUBAGENT_SUMMARY_CHARS = 4_000;

/** One child as the model asks for it in an `agents` call. */
export interface SubagentSpec {
	label: string;
	task: string;
	kind?: SubagentKind;
	/** Labels of other children of the same call that must finish (and be merged) first. */
	depends_on?: string[];
}

export interface SubagentModelRef {
	provider: string;
	id: string;
}

/** A sub-agent as the engine reports it. */
export interface SubagentInfo {
	/** `sub_<n>`, unique in the process. The main agent is `main`. */
	id: string;
	parentId: "main";
	label: string;
	task: string;
	kind: SubagentKind;
	/** The model it runs (or would run) on. */
	model?: SubagentModelRef;
	/** Its git worktree, relative to the repository root (e.g. `.fingers/worktrees/sub_3`). */
	worktree?: string;
	/** Ids of the sub-agents it waits for. */
	dependsOn: string[];
	status: SubagentStatus;
	/** Its model calls so far (list prices). */
	usage: Usage;
	/** Its last answer, or why it failed or stopped. */
	summary?: string;
	/** For `done`: files its changes touched. */
	filesChanged?: number;
	/** For `done`: its changes are in the parent's working tree. */
	merged?: boolean;
	/** The worktree was kept (changes that could not be merged, or work of a child that did not finish). */
	keptWorktree?: string;
	startedAt?: number;
	endedAt?: number;
}

/** A lifecycle change, in the order of the contract's events. */
export type SubagentEvent =
	| { type: "subagent_started"; agent: SubagentInfo }
	| { type: "subagent_updated"; agent: SubagentInfo }
	| { type: "subagent_finished"; agent: SubagentInfo };

/** How a child's run ended. */
export interface SubagentChildOutcome {
	status: SubagentEndStatus;
	/** The child's last answer, or the error. */
	summary: string;
}

/** A child session the core made for the engine. */
export interface SubagentChild {
	readonly id: string;
	/** Runs the task and resolves when the child is idle again. Never rejects. */
	run(): Promise<SubagentChildOutcome>;
	/** A message for the child, delivered before its next model call. False when it is not running. */
	steer(text: string): boolean;
	/** Stops the child's run; `run()` then resolves as `stopped`. */
	abort(): void;
	/** Its model calls so far. */
	usage(): Usage;
	/** Called after each of its model calls with its usage so far. Returns the unsubscribe function. */
	onUsage(listener: (usage: Usage) => void): () => void;
	/** Called when it starts and stops waiting for the person's approval. Returns the unsubscribe function. */
	onApproval(listener: (waiting: boolean) => void): () => void;
	/** Frees the session. */
	dispose(): void;
}

export interface SubagentChildOptions {
	id: string;
	label: string;
	task: string;
	/** The child's working directory: the parent's directory inside the child's worktree. */
	cwd: string;
	model?: SubagentModelRef;
}

/** What the core offers the engine for one `agents` call. */
export interface SubagentRunHost {
	/** The parent session's working directory. */
	readonly cwd: string;
	/** Aborted when the parent's tool call is (Esc, the run stops). */
	readonly signal: AbortSignal;
	/** The model a child of this kind runs on: a cheaper one when routing picks one, else the parent's. */
	pickModel(kind: SubagentKind): SubagentModelRef | undefined;
	/** Makes a child session. Rejects when it cannot (no model, no credentials). */
	startChild(options: SubagentChildOptions): Promise<SubagentChild>;
	/** A lifecycle change (the tool's progress, the registry's listeners). */
	report(event: SubagentEvent): void;
	/**
	 * Whether the parent's cost budget is reached once `childrenCostUsd` (what this call's children cost so far) is
	 * added to what the session spent. False without a budget.
	 */
	budgetReached(childrenCostUsd: number): boolean;
}

export interface SubagentRunRequest {
	toolCallId: string;
	agents: readonly SubagentSpec[];
}

export interface SubagentRunResult {
	agents: SubagentInfo[];
	/** For the model: one line per child. */
	text: string;
	/** Every child's model calls together. */
	usage: Usage;
}

/** The engine an ee feature registers (EeHost.registerSubagentEngine). */
export interface SubagentEngine {
	/** Runs the children of one `agents` call; resolves when every child ended. Rejects only for a bad request. */
	run(request: SubagentRunRequest, host: SubagentRunHost): Promise<SubagentRunResult>;
	/** Sends a message to a running child. False when there is none with that id. */
	steer(id: string, text: string): boolean;
	/** Stops a running or queued child. False when there is none with that id. */
	stop(id: string): boolean;
	/** The sub-agents of this process, oldest first. */
	list(): readonly SubagentInfo[];
}

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
