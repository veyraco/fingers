/**
 * Hands' public runs API (`<api>/hands/v1`, platform contracts/openapi/hands.yaml) as the signed-in person, for
 * Fingers sessions that run in a Hands Sandbox (`fingers --hands`, F13b).
 *
 * - Every request carries the person's Connect access token for Hands (`aud` = hands), fetched per request so a
 *   refresh happens when it is due; nothing here stores it. A run never gets a provider key: Hands leases the model
 *   connection's credential itself and keeps it in its model egress proxy (rule `model-egress`).
 * - Every request carries an `X-Request-Id` and a W3C `traceparent` (a child span of the session's trace,
 *   contracts/v1/logging.md); creating POSTs carry an `Idempotency-Key`.
 * - Errors come as `application/problem+json` (contracts/v1/schemas/error.schema.json) and are thrown as
 *   HandsApiError with Hands' code, detail and field errors, made safe to print.
 */
import { randomUUID } from "node:crypto";
import { childSpan, formatTraceparent, type TraceContext } from "../trace-context.ts";
import { connectText } from "./login-text.ts";

/** hands.yaml RunStatus. */
export type HandsRunStatus =
	| "queued"
	| "starting"
	| "running"
	| "needs_approval"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "timed_out";

export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

/** hands.yaml Workspace (what Fingers sends). */
export type HandsWorkspace =
	| { type: "git"; repo: string; ref?: string; file_ids?: string[] }
	| { type: "files"; file_ids: string[] }
	| { type: "empty" };

/** hands.yaml RunCreate, the fields Fingers sets. */
export interface HandsRunCreate {
	task: { title?: string; prompt: string };
	model: { connection_id: string; model: string };
	harness: { name: "fingers"; version?: string };
	workspace: HandsWorkspace;
	target: { type: "sandbox"; size?: string };
	observability: { send_to_eyes: boolean };
	memory?: { brain_space_id: string; learn: boolean };
	metadata?: Record<string, string>;
}

/** hands.yaml Run, the fields Fingers reads. */
export interface HandsRun {
	id: string;
	status: HandsRunStatus;
	attempt?: number;
	target?: { type?: string; size?: string; sandbox_id?: string | null };
	model?: { connection_id?: string; model?: string };
	usage?: {
		duration_seconds?: number;
		input_tokens?: number;
		output_tokens?: number;
		cached_input_tokens?: number;
		/** common.yaml Money. */
		model_cost?: { amount_minor?: number; currency?: string };
	};
	failure?: { code?: string; message?: string } | null;
	pending_approval_id?: string | null;
	eyes_url?: string | null;
	trace_id?: string;
}

/** hands.yaml RunEvent. */
export interface HandsRunEvent {
	id: string;
	run_id: string;
	attempt?: number;
	seq: number;
	type: string;
	at: string;
	checkpoint_id?: string | null;
	data: Record<string, unknown>;
}

/** hands.yaml ChangedFile. */
export interface HandsChangedFile {
	path: string;
	change: "added" | "modified" | "deleted" | "renamed";
	previous_path?: string | null;
	additions: number;
	deletions: number;
	binary?: boolean;
	size_bytes?: number;
}

/** hands.yaml Approval, the fields Fingers shows. */
export interface HandsApproval {
	id: string;
	run_id: string;
	status: "pending" | "approved" | "denied" | "expired";
	tool: { server: string; name: string; arguments?: Record<string, unknown> };
	reason?: string;
}

/** hands.yaml Checkpoint. */
export interface HandsCheckpoint {
	id: string;
	run_id: string;
	attempt?: number;
	label: string;
	event_seq?: number;
	created_at: string;
}

/** hands.yaml UploadedFile. */
export interface HandsUploadedFile {
	id: string;
	name: string;
	path?: string;
	size_bytes: number;
	sha256?: string;
}

/** Hands refused a request (problem+json), or answered something Fingers can't read. Texts are safe to print. */
export class HandsApiError extends Error {
	readonly status: number;
	readonly code: string | undefined;
	readonly detail: string | undefined;
	readonly permission: string | undefined;
	readonly fieldErrors: ReadonlyArray<{ field?: string; message: string }>;

	constructor(
		status: number,
		problem: {
			code?: string;
			title?: string;
			detail?: string;
			permission?: string;
			errors?: Array<{ field?: string; message: string }>;
		},
	) {
		const detail = problem.detail ?? problem.title;
		super(`Hands answered ${status}${problem.code ? ` ${problem.code}` : ""}${detail ? `: ${detail}` : ""}`);
		this.name = "HandsApiError";
		this.status = status;
		this.code = problem.code;
		this.detail = detail;
		this.permission = problem.permission;
		this.fieldErrors = problem.errors ?? [];
	}

	/** The field error for `field` (hands.yaml 400 `errors[]`), when Hands named it. */
	fieldError(field: string): string | undefined {
		return this.fieldErrors.find((error) => error.field === field)?.message;
	}
}

/** The part of VeyraAuth the client needs (tests pass a stub). */
export interface HandsAuth {
	apiBaseUrl(app: "hands"): string;
	getAccessToken(app: "hands", options?: { signal?: AbortSignal }): Promise<string>;
}

export interface HandsClientOptions {
	auth: HandsAuth;
	/** The session's trace: every request is a child span of it. */
	trace: TraceContext;
	userAgent?: string;
	fetch?: typeof fetch;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function safe(value: unknown, max = 2_000): string | undefined {
	return typeof value === "string" && value.length > 0 ? connectText(value.slice(0, max)) : undefined;
}

/** A problem+json body as HandsApiError fields, every text made safe to print. */
export function readProblem(body: unknown): ConstructorParameters<typeof HandsApiError>[1] {
	const value = record(body) ?? {};
	const errors = Array.isArray(value.errors)
		? value.errors.flatMap((entry) => {
				const item = record(entry);
				const message = safe(item?.message, 500);
				return message ? [{ ...(safe(item?.field, 200) ? { field: safe(item?.field, 200) } : {}), message }] : [];
			})
		: undefined;
	return {
		code: typeof value.code === "string" && /^[a-z][a-z0-9_]*$/.test(value.code) ? value.code : undefined,
		title: safe(value.title, 200),
		detail: safe(value.detail),
		permission: safe(value.permission, 200),
		...(errors && errors.length > 0 ? { errors } : {}),
	};
}

export class HandsClient {
	readonly baseUrl: string;
	private readonly auth: HandsAuth;
	private readonly trace: TraceContext;
	private readonly userAgent: string | undefined;
	private readonly fetchImpl: typeof fetch;

	constructor(options: HandsClientOptions) {
		this.auth = options.auth;
		this.baseUrl = options.auth.apiBaseUrl("hands").replace(/\/+$/, "");
		this.trace = options.trace;
		this.userAgent = options.userAgent;
		this.fetchImpl = options.fetch ?? fetch;
	}

	private async headers(
		signal: AbortSignal | undefined,
		extra: Record<string, string> = {},
	): Promise<Record<string, string>> {
		const token = await this.auth.getAccessToken("hands", { signal });
		const headers: Record<string, string> = {
			authorization: `Bearer ${token}`,
			"x-request-id": randomUUID(),
			traceparent: formatTraceparent(childSpan(this.trace)),
			...extra,
		};
		if (this.userAgent) headers["user-agent"] = this.userAgent;
		return headers;
	}

	private async send(
		method: string,
		path: string,
		options: {
			json?: unknown;
			body?: FormData;
			idempotencyKey?: string;
			accept?: string;
			signal?: AbortSignal;
			headers?: Record<string, string>;
		} = {},
	): Promise<Response> {
		const extra: Record<string, string> = { accept: options.accept ?? "application/json", ...options.headers };
		if (options.json !== undefined) extra["content-type"] = "application/json";
		if (options.idempotencyKey) extra["idempotency-key"] = options.idempotencyKey;
		const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
			method,
			headers: await this.headers(options.signal, extra),
			body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
			signal: options.signal,
		});
		if (!response.ok) {
			let body: unknown;
			try {
				body = await response.json();
			} catch {
				body = undefined;
			}
			throw new HandsApiError(response.status, readProblem(body));
		}
		return response;
	}

	private async json<T>(method: string, path: string, options: Parameters<HandsClient["send"]>[2] = {}): Promise<T> {
		const response = await this.send(method, path, options);
		try {
			return (await response.json()) as T;
		} catch {
			throw new HandsApiError(response.status, { detail: "Hands' answer is not readable JSON." });
		}
	}

	/** `POST /files`: one workspace file at `path` (hands.yaml uploadFile). */
	async uploadFile(
		file: { path: string; bytes: Uint8Array; idempotencyKey: string },
		signal?: AbortSignal,
	): Promise<HandsUploadedFile> {
		const form = new FormData();
		form.set("path", file.path);
		form.set(
			"file",
			new Blob([new Uint8Array(file.bytes)], { type: "application/octet-stream" }),
			basename(file.path),
		);
		return this.json<HandsUploadedFile>("POST", "/files", {
			body: form,
			idempotencyKey: file.idempotencyKey,
			signal,
		});
	}

	/** `POST /runs` (hands.yaml createRun). */
	createRun(body: HandsRunCreate, idempotencyKey: string, signal?: AbortSignal): Promise<HandsRun> {
		return this.json<HandsRun>("POST", "/runs", { json: body, idempotencyKey, signal });
	}

	getRun(runId: string, signal?: AbortSignal): Promise<HandsRun> {
		return this.json<HandsRun>("GET", `/runs/${encodeURIComponent(runId)}`, { signal });
	}

	cancelRun(runId: string, reason: string, signal?: AbortSignal): Promise<HandsRun> {
		return this.json<HandsRun>("POST", `/runs/${encodeURIComponent(runId)}/cancel`, { json: { reason }, signal });
	}

	/** `POST /runs/{id}/messages`: steer the running agent (hands.yaml sendRunMessage). */
	async sendMessage(runId: string, text: string, signal?: AbortSignal): Promise<void> {
		await this.json("POST", `/runs/${encodeURIComponent(runId)}/messages`, { json: { text }, signal });
	}

	getApproval(approvalId: string, signal?: AbortSignal): Promise<HandsApproval> {
		return this.json<HandsApproval>("GET", `/approvals/${encodeURIComponent(approvalId)}`, { signal });
	}

	decideApproval(
		approvalId: string,
		decision: "approve" | "deny",
		reason: string | undefined,
		signal?: AbortSignal,
	): Promise<HandsApproval> {
		return this.json<HandsApproval>("POST", `/approvals/${encodeURIComponent(approvalId)}/decision`, {
			json: { decision, ...(reason ? { reason } : {}) },
			idempotencyKey: randomUUID(),
			signal,
		});
	}

	/** `GET /runs/{id}/events` from `after` (hands.yaml listRunEvents). */
	listEvents(
		runId: string,
		after: number,
		signal?: AbortSignal,
	): Promise<{ data: HandsRunEvent[]; has_more: boolean; last_seq: number }> {
		return this.json("GET", `/runs/${encodeURIComponent(runId)}/events?after=${after}&limit=1000`, { signal });
	}

	/**
	 * `GET /runs/{id}/events/stream` (SSE) from `after`: yields each event in order; ends when Hands ends the stream
	 * (after `run.finished`, or when the connection drops). The caller reconnects from the last `seq` it saw.
	 */
	async *streamEvents(runId: string, after: number, signal?: AbortSignal): AsyncGenerator<HandsRunEvent> {
		const response = await this.send("GET", `/runs/${encodeURIComponent(runId)}/events/stream?after=${after}`, {
			accept: "text/event-stream",
			headers: after > 0 ? { "last-event-id": String(after) } : {},
			signal,
		});
		if (!response.body) return;
		const decoder = new TextDecoder();
		let buffer = "";
		let data: string[] = [];
		const reader = response.body.getReader();
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline).replace(/\r$/, "");
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
					if (line === "") {
						if (data.length > 0) {
							const event = parseRunEvent(data.join("\n"));
							data = [];
							if (event) yield event;
						}
					} else if (line.startsWith("data:")) {
						data.push(line.slice(5).replace(/^ /, ""));
					}
					// `id:`, `event:` and `: ping` lines carry nothing the event's JSON does not.
				}
			}
		} finally {
			reader.releaseLock();
			await response.body.cancel().catch(() => undefined);
		}
	}

	/** `GET /runs/{id}/files`: the files the run changed (hands.yaml listRunFiles). */
	async listChangedFiles(runId: string, signal?: AbortSignal): Promise<HandsChangedFile[]> {
		const body = await this.json<{ data?: unknown }>("GET", `/runs/${encodeURIComponent(runId)}/files`, { signal });
		return Array.isArray(body.data) ? (body.data as HandsChangedFile[]) : [];
	}

	/** `GET /runs/{id}/files/content?path=`: a file of the run's final workspace (a 302 is followed). */
	async fileContent(runId: string, path: string, signal?: AbortSignal): Promise<Uint8Array> {
		const response = await this.send(
			"GET",
			`/runs/${encodeURIComponent(runId)}/files/content?path=${encodeURIComponent(path)}`,
			{ accept: "application/octet-stream", signal },
		);
		return new Uint8Array(await response.arrayBuffer());
	}

	async listCheckpoints(runId: string, signal?: AbortSignal): Promise<HandsCheckpoint[]> {
		const body = await this.json<{ data?: unknown }>("GET", `/runs/${encodeURIComponent(runId)}/checkpoints`, {
			signal,
		});
		return Array.isArray(body.data) ? (body.data as HandsCheckpoint[]) : [];
	}

	/** `POST /runs/{id}/checkpoints/{cp}/fork` with an extra instruction (hands.yaml forkCheckpoint). */
	forkCheckpoint(runId: string, checkpointId: string, message: string, signal?: AbortSignal): Promise<HandsRun> {
		return this.json<HandsRun>(
			"POST",
			`/runs/${encodeURIComponent(runId)}/checkpoints/${encodeURIComponent(checkpointId)}/fork`,
			{ json: { message }, idempotencyKey: randomUUID(), signal },
		);
	}
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1) || "file";
}

/** One SSE `data:` payload as a RunEvent; undefined when it is not one. */
export function parseRunEvent(text: string): HandsRunEvent | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	const event = record(value);
	if (!event || typeof event.type !== "string" || typeof event.seq !== "number") return undefined;
	return { ...(event as unknown as HandsRunEvent), data: record(event.data) ?? {} };
}
