// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * The Brain memory provider (F20): the core's memory interface on Brain's public API
 * (`api.veyra.so/brain/v1`, veyraco/platform contracts/openapi/brain.yaml) as the signed-in person.
 *
 * One memory per repository: the `project` subject whose id is the repository (`github.com/acme/web`), addressed as
 * `subject:project:<id>`, so every clone and every member of the organization shares it and Brain creates it on the
 * first write. A read of a repository Brain has no memory of yet is an empty answer, not an error. The token is for
 * Brain only (`aud` = brain) and comes from the core for every call; nothing here stores it.
 *
 * A provider belongs to one organization (the one signed in when it was made): its key is `<org_id>:<repository>`,
 * and once the sign-in moves to another organization (`/org switch`) it refuses every call instead of sending that
 * organization's token with the first one's memory.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type {
	EeVeyraApi,
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
} from "@veyraco/fingers";

/** The core turns this into its MemoryUnavailableError by name and code (ee imports only the core's types). */
export class BrainUnavailableError extends Error {
	readonly code: string;
	readonly status?: number;

	constructor(code: string, message: string, status?: number) {
		super(message);
		this.name = "MemoryUnavailableError";
		this.code = code;
		this.status = status;
	}
}

type Fetch = typeof fetch;

export interface BrainProviderOptions {
	api: EeVeyraApi;
	/** The organization (`org_…`) whose memory this is: the one signed in now. */
	org: string;
	/** `github.com/acme/web`. */
	repository: string;
	/** Shown in the status line: `web`. */
	scope: string;
	fetch?: Fetch;
}

/** `subject:project:<repository>`, Brain's address of the repository's space. */
export function repositorySpace(repository: string): string {
	return `subject:project:${repository}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function traceparent(): string {
	return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}

/** Brain answered 404: the repository has no memory yet (reads), or it is not visible to this person. */
class NotFound extends Error {}

export class BrainMemoryProvider implements MemoryProvider {
	readonly name = "Brain";
	readonly scope: string;
	readonly repository: string;
	readonly org: string;
	/** `<org_id>:<repository>` (MemoryProvider.key). */
	readonly key: string;
	private readonly api: EeVeyraApi;
	private readonly fetch: Fetch;

	constructor(options: BrainProviderOptions) {
		this.api = options.api;
		if (!options.org) throw new Error("Brain memory needs the signed-in organization");
		this.org = options.org;
		this.repository = options.repository;
		this.key = `${options.org}:${options.repository}`;
		this.scope = options.scope;
		this.fetch = options.fetch ?? fetch;
	}

	private url(operation: "context" | "recall" | "memories" | "events"): string {
		const base = this.api.baseUrl.replace(/\/+$/, "");
		return `${base}/spaces/${encodeURIComponent(repositorySpace(this.repository))}/${operation}`;
	}

	private async post(
		operation: "context" | "recall" | "memories" | "events",
		body: unknown,
		options: MemoryCallOptions | undefined,
	): Promise<Record<string, unknown>> {
		// The sign-in moved to another organization: never this organization's memory with that one's token.
		const orgChanged = () =>
			new BrainUnavailableError(
				"org_changed",
				"the signed-in organization changed; this memory belongs to the previous one",
			);
		if (this.api.org !== this.org) throw orgChanged();
		let token: string;
		try {
			token = await this.api.accessToken({ signal: options?.signal });
		} catch (error) {
			throw new BrainUnavailableError(
				"no_token",
				`no Brain access: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		// A switch that finished while the token was fetched: that token is the other organization's.
		if (this.api.org !== this.org) throw orgChanged();
		let response: Response;
		try {
			response = await this.fetch(this.url(operation), {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					accept: "application/json",
					"x-request-id": `req_${randomUUID().replace(/-/g, "")}`,
					traceparent: traceparent(),
				},
				body: JSON.stringify(body),
				signal: options?.signal,
			});
		} catch (error) {
			if (options?.signal?.aborted) throw error;
			throw new BrainUnavailableError(
				"unreachable",
				`Brain is not reachable: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const text = await response.text().catch(() => "");
		let parsed: unknown;
		try {
			parsed = text ? JSON.parse(text) : undefined;
		} catch {
			parsed = undefined;
		}
		if (response.status === 404) throw new NotFound();
		if (!response.ok) {
			const problem = asRecord(parsed);
			const code = typeof problem?.code === "string" ? problem.code : `http_${response.status}`;
			const detail =
				typeof problem?.detail === "string"
					? problem.detail
					: typeof problem?.title === "string"
						? problem.title
						: `HTTP ${response.status}`;
			throw new BrainUnavailableError(code, `Brain refused the request (${code}): ${detail}`, response.status);
		}
		const data = asRecord(parsed);
		if (!data) throw new BrainUnavailableError("invalid_response", "Brain's answer is not a JSON object");
		return data;
	}

	async context(request: MemoryContextRequest, options?: MemoryCallOptions): Promise<MemoryContextResult> {
		let data: Record<string, unknown>;
		try {
			data = await this.post("context", request, options);
		} catch (error) {
			if (error instanceof NotFound) return { context: "", tokens: 0 };
			throw error;
		}
		if (typeof data.context !== "string")
			throw new BrainUnavailableError("invalid_response", "no context in Brain's answer");
		return { context: data.context, tokens: typeof data.tokens === "number" ? data.tokens : 0 };
	}

	async recall(request: MemoryRecallRequest, options?: MemoryCallOptions): Promise<MemoryRecallItem[]> {
		let data: Record<string, unknown>;
		try {
			data = await this.post("recall", request, options);
		} catch (error) {
			if (error instanceof NotFound) return [];
			throw error;
		}
		if (!Array.isArray(data.data)) throw new BrainUnavailableError("invalid_response", "no items in Brain's answer");
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
		let data: Record<string, unknown>;
		try {
			data = await this.post("memories", request, options);
		} catch (error) {
			if (error instanceof NotFound) {
				throw new BrainUnavailableError(
					"not_found",
					"Brain does not let you write to this repository's memory",
					404,
				);
			}
			throw error;
		}
		if (typeof data.id !== "string") throw new BrainUnavailableError("invalid_response", "no id in Brain's answer");
		return { id: data.id, merged_into: typeof data.merged_into === "string" ? data.merged_into : null };
	}

	async reportEvents(events: MemoryLearningEvent[], options?: MemoryCallOptions): Promise<MemoryEventsResult> {
		let data: Record<string, unknown>;
		try {
			data = await this.post("events", { events }, options);
		} catch (error) {
			if (error instanceof NotFound) {
				throw new BrainUnavailableError(
					"not_found",
					"Brain does not let you write to this repository's memory",
					404,
				);
			}
			throw error;
		}
		return {
			accepted: typeof data.accepted === "number" ? data.accepted : 0,
			duplicates: typeof data.duplicates === "number" ? data.duplicates : 0,
		};
	}
}
