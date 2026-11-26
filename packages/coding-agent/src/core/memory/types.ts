/**
 * The memory provider interface (open core, MIT). A memory provider gives the agent what it should know for a task,
 * lets the model search and add to it, and learns from how tasks went. Fingers ships two: the Brain provider in ee
 * (the terminal app, signed in, a tier that includes Brain) and the relay provider of managed RPC mode, which asks the
 * host (the Hands runner) to call Brain and never calls it itself.
 *
 * The request and result shapes are Brain's wire shapes (veyraco/platform contracts/openapi/brain.yaml, operations
 * assembleContext, recall, remember and reportLearningEvents) without a space: the provider decides the space (Brain:
 * one per repository; relay: the host's run space), never the model or the request.
 */

/** Brain's MemoryType. */
export const MEMORY_TYPES = ["fact", "preference", "episode", "procedure"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** A reference to something outside the memory, e.g. the Hands run or the Fingers session the item came from. */
export interface MemoryRef {
	app: string;
	type: string;
	id: string;
}

/** assembleContext: "what should the agent know for this task, within max_tokens". */
export interface MemoryContextRequest {
	task: string;
	max_tokens: number;
	format?: "markdown" | "xml" | "items_only";
	run_ref?: MemoryRef;
}

export interface MemoryContextResult {
	/** Ready to put into the prompt; empty when the memory knows nothing for the task. */
	context: string;
	tokens: number;
}

/** recall: a search in the memory. */
export interface MemoryRecallRequest {
	query: string;
	limit?: number;
	types?: MemoryType[];
}

export interface MemoryRecallItem {
	/** `lt_1842 v3` or a session note ref. */
	ref: string;
	kind: string;
	text: string;
	score: number;
	confidence?: number;
}

/** remember: a long-term item. */
export interface MemoryRememberRequest {
	type: MemoryType;
	text: string;
	tags?: string[];
	refs?: MemoryRef[];
}

export interface MemoryRememberResult {
	id: string;
	/** Set when the memory merged the write into an item that says the same thing. */
	merged_into?: string | null;
}

/** reportLearningEvents: one event of how a task went. `id` makes it idempotent. */
export interface MemoryLearningEvent {
	id: string;
	kind: "run_event" | "outcome" | "correction" | "conversation_turn";
	/** ISO 8601. */
	at: string;
	text?: string;
	ref?: MemoryRef;
	outcome?: { status: "succeeded" | "failed" | "reversed" | "abandoned"; summary?: string };
}

export interface MemoryEventsResult {
	accepted: number;
	duplicates: number;
}

export interface MemoryCallOptions {
	signal?: AbortSignal;
}

export interface MemoryProvider {
	/** "Brain", as the status line shows it ("memory: Brain “web”"). */
	readonly name: string;
	/** What the memory is about, e.g. the repository's short name; shown after the name. */
	readonly scope?: string;
	/**
	 * Whose memory this is: the organization and what in it (Brain: `<org_id>:<repository>`; relay: the Hands run).
	 * A session keeps the task's memory with this key and reuses it only for a provider with the same key, so one
	 * organization's memory never reaches a run of another (`/org switch`, a resume while signed in to another org).
	 * Never empty.
	 */
	readonly key: string;
	context(request: MemoryContextRequest, options?: MemoryCallOptions): Promise<MemoryContextResult>;
	recall(request: MemoryRecallRequest, options?: MemoryCallOptions): Promise<MemoryRecallItem[]>;
	remember(request: MemoryRememberRequest, options?: MemoryCallOptions): Promise<MemoryRememberResult>;
	reportEvents(events: MemoryLearningEvent[], options?: MemoryCallOptions): Promise<MemoryEventsResult>;
}

/** Where a provider is asked for: the session's working directory and its repository (core/memory/project.ts). */
export interface MemoryProviderContext {
	cwd: string;
	/** `github.com/acme/web`; undefined outside a git repository with a remote. */
	repository?: string;
}

/**
 * The memory could not answer (not reachable, refused, timed out, an answer that is not the contract's). Memory is
 * best effort: the session goes on without it.
 */
export class MemoryUnavailableError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "MemoryUnavailableError";
		this.code = code;
	}
}

/** "Brain “web”" for the status line, or just the name. */
export function memoryLabel(provider: Pick<MemoryProvider, "name" | "scope">): string {
	return provider.scope ? `${provider.name} “${provider.scope}”` : provider.name;
}
