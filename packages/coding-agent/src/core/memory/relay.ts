/**
 * The relay memory provider of managed RPC mode (Fingers RPC v1, "Memory relay"): Fingers holds no Veyra token in a
 * sandbox and never calls Brain. Each operation becomes a `memory_request` the host answers with `memory_response`
 * after calling Brain on the run's own space with its own identity. The request body never names a space or an
 * organization (the host would ignore them anyway).
 */
import type {
	MemoryCallOptions,
	MemoryContextRequest,
	MemoryContextResult,
	MemoryEventsResult,
	MemoryLearningEvent,
	MemoryProvider,
	MemoryRecallItem,
	MemoryRecallRequest,
	MemoryRememberRequest,
	MemoryRememberResult,
} from "./types.ts";
import { MemoryUnavailableError } from "./types.ts";

export type MemoryRelayOp = "context" | "recall" | "remember" | "events";

export interface MemoryRequestRecord {
	type: "memory_request";
	id: string;
	op: MemoryRelayOp;
	body: Record<string, unknown>;
	timeout_ms: number;
}

export interface MemoryResponseRecord {
	type: "memory_response";
	id: string;
	ok: boolean;
	data?: Record<string, unknown>;
	error?: { code?: string; message?: string };
}

/** Keys the contract forbids in a request body: the host picks the space and the organization. */
const TARGET_KEYS = new Set(["space_id", "space_ids", "brain_space_id", "org_id", "organization_id"]);

const DEFAULT_TIMEOUT_MS: Record<MemoryRelayOp, number> = {
	context: 3_000,
	recall: 10_000,
	remember: 10_000,
	events: 5_000,
};

interface Pending {
	op: MemoryRelayOp;
	resolve(data: Record<string, unknown>): void;
	reject(error: MemoryUnavailableError): void;
	timer: ReturnType<typeof setTimeout>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function invalid(op: MemoryRelayOp): MemoryUnavailableError {
	return new MemoryUnavailableError("invalid_response", `The host's ${op} answer is not a Brain ${op} result`);
}

export class RelayMemoryProvider implements MemoryProvider {
	readonly name = "Brain";
	readonly scope = undefined;
	private readonly pending = new Map<string, Pending>();
	private next = 0;
	private readonly emit: (record: MemoryRequestRecord) => void;
	private readonly timeouts: Record<MemoryRelayOp, number>;
	private closed = false;

	constructor(options: {
		emit(record: MemoryRequestRecord): void;
		timeoutMs?: Partial<Record<MemoryRelayOp, number>>;
	}) {
		this.emit = options.emit;
		this.timeouts = { ...DEFAULT_TIMEOUT_MS, ...options.timeoutMs };
	}

	/** Requests waiting for the host. */
	get waiting(): number {
		return this.pending.size;
	}

	/** A `memory_response` from the host. False when no request with that id is waiting (late, unknown, answered). */
	respond(record: MemoryResponseRecord): boolean {
		const pending = this.pending.get(record.id);
		if (!pending) return false;
		this.pending.delete(record.id);
		clearTimeout(pending.timer);
		if (record.ok) {
			const data = asRecord(record.data);
			if (data) pending.resolve(data);
			else pending.reject(invalid(pending.op));
		} else {
			const code = typeof record.error?.code === "string" && record.error.code ? record.error.code : "unavailable";
			const message =
				typeof record.error?.message === "string" && record.error.message
					? record.error.message
					: "The host could not reach the memory";
			pending.reject(new MemoryUnavailableError(code, message));
		}
		return true;
	}

	/** The session is ending: every waiting request fails at once. */
	close(): void {
		this.closed = true;
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			clearTimeout(pending.timer);
			pending.reject(new MemoryUnavailableError("closed", "Fingers is shutting down"));
		}
	}

	private request(op: MemoryRelayOp, body: Record<string, unknown>, options?: MemoryCallOptions) {
		for (const key of Object.keys(body)) if (TARGET_KEYS.has(key)) delete body[key];
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			if (this.closed) return reject(new MemoryUnavailableError("closed", "Fingers is shutting down"));
			const signal = options?.signal;
			if (signal?.aborted) return reject(new MemoryUnavailableError("aborted", "The memory request was cancelled"));
			const id = `memreq_${++this.next}`;
			const timeoutMs = this.timeouts[op];
			const settle = () => signal?.removeEventListener("abort", onAbort);
			const onAbort = () => {
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);
				clearTimeout(pending.timer);
				reject(new MemoryUnavailableError("aborted", "The memory request was cancelled"));
			};
			const timer = setTimeout(() => {
				if (!this.pending.delete(id)) return;
				settle();
				reject(
					new MemoryUnavailableError("timeout", `The host did not answer the ${op} request in ${timeoutMs} ms`),
				);
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, {
				op,
				timer,
				resolve: (data) => {
					settle();
					resolve(data);
				},
				reject: (error) => {
					settle();
					reject(error);
				},
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			this.emit({ type: "memory_request", id, op, body, timeout_ms: timeoutMs });
		});
	}

	async context(request: MemoryContextRequest, options?: MemoryCallOptions): Promise<MemoryContextResult> {
		const data = await this.request("context", { ...request }, options);
		if (typeof data.context !== "string") throw invalid("context");
		return { context: data.context, tokens: typeof data.tokens === "number" ? data.tokens : 0 };
	}

	async recall(request: MemoryRecallRequest, options?: MemoryCallOptions): Promise<MemoryRecallItem[]> {
		const data = await this.request("recall", { ...request }, options);
		if (!Array.isArray(data.data)) throw invalid("recall");
		return data.data.flatMap((value) => {
			const item = asRecord(value);
			if (!item || typeof item.text !== "string") return [];
			return [
				{
					ref: typeof item.ref === "string" ? item.ref : "",
					kind: typeof item.kind === "string" ? item.kind : "fact",
					text: item.text,
					score: typeof item.score === "number" ? item.score : 0,
					...(typeof item.confidence === "number" ? { confidence: item.confidence } : {}),
				},
			];
		});
	}

	async remember(request: MemoryRememberRequest, options?: MemoryCallOptions): Promise<MemoryRememberResult> {
		const data = await this.request("remember", { ...request }, options);
		if (typeof data.id !== "string") throw invalid("remember");
		return { id: data.id, merged_into: typeof data.merged_into === "string" ? data.merged_into : null };
	}

	async reportEvents(events: MemoryLearningEvent[], options?: MemoryCallOptions): Promise<MemoryEventsResult> {
		const data = await this.request("events", { events }, options);
		return {
			accepted: typeof data.accepted === "number" ? data.accepted : 0,
			duplicates: typeof data.duplicates === "number" ? data.duplicates : 0,
		};
	}
}
