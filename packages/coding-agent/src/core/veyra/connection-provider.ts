/**
 * One Veyra model connection as a Fingers provider (`veyra-<connection id>`), and the process' set of them
 * (`veyraModelConnections`), applied to every model runtime the app creates (start, /new, /resume, /fork).
 *
 * - Models: the connection's provider's models (Fingers' catalog for anthropic, openai, google, openrouter, xai,
 *   moonshotai), with the base URL of Hands' model proxy for this connection
 *   (`<api>/hands/v1/model-proxy/{connection_id}/{wire}`).
 * - Requests: the built-in provider's request code, with `Authorization: Bearer <the person's Hands token>` from
 *   VeyraAuth on every call (refreshed by VeyraAuth when it nears its end). No key is ever held: the provider has no
 *   stored or runtime credential, nothing goes to auth.json or models.json.
 * - The provider id: requests run under the built-in provider's id, so its provider-specific request shapes (OpenRouter
 *   routing, xAI and Moonshot compat, thinking signatures) apply; answers carry the connection's provider id, so the
 *   session, `/model` and cost records name the Veyra connection.
 * - Errors: a refusal by Hands or Connect (401, 403, 404) says which connection and what to do; other errors pass
 *   unchanged so retry and context-overflow handling still read them.
 */
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	createProvider,
	type Message,
	type Model,
	type Provider,
	type ProviderHeaders,
	type SimpleStreamOptions,
	type StreamOptions,
	type TranscriptContext,
} from "@veyraco/fingers-ai";
import { builtinProviders } from "@veyraco/fingers-ai/providers/all";
import type { ModelRuntime } from "../model-runtime.ts";
import { connectText } from "./login-text.ts";
import {
	fetchModelConnections,
	isConnectionProviderId,
	type ModelConnectionsList,
	type ModelConnectionsSource,
	type OfferedConnection,
	type ProxyWire,
	proxyBaseUrl,
} from "./model-connections.ts";
import { VeyraAudienceError, VeyraSignedOutError } from "./veyra-auth.ts";

/** Gives the person's Connect access token for Hands; VeyraAuth.getAccessToken("hands"). */
export type HandsTokenSource = (signal?: AbortSignal) => Promise<string>;

/** Sent where a provider client insists on an API key but Hands takes the person's token from Authorization. */
const NO_KEY = "veyra-hands";

let rawBuiltins: Map<string, Provider> | undefined;

/** The built-in provider `id` as Fingers ships it, without models.json or extension overlays. */
function builtinProvider(id: string): Provider | undefined {
	rawBuiltins ??= new Map(builtinProviders().map((provider) => [provider.id, provider]));
	return rawBuiltins.get(id);
}

function withoutHeader(headers: ProviderHeaders | undefined, name: string): ProviderHeaders {
	const lower = name.toLowerCase();
	return Object.fromEntries(Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() !== lower));
}

/** The request options for `wire` with the person's token: Hands reads only `Authorization: Bearer`. */
function authorized<T extends StreamOptions>(options: T | undefined, wire: ProxyWire, token: string): T {
	const headers = withoutHeader(withoutHeader(options?.headers, "authorization"), "x-api-key");
	const bearer = `Bearer ${token}`;
	switch (wire) {
		// The OpenAI clients send their key as `Authorization: Bearer`.
		case "openai":
			return { ...(options ?? ({} as T)), apiKey: token, headers };
		// Anthropic: header-owned auth (no x-api-key). Gemini's client needs a key; Hands drops x-goog-api-key.
		case "anthropic":
			return { ...(options ?? ({} as T)), apiKey: undefined, headers: { ...headers, Authorization: bearer } };
		case "google":
			return { ...(options ?? ({} as T)), apiKey: NO_KEY, headers: { ...headers, Authorization: bearer } };
	}
}

/** The context with this connection's earlier answers under the built-in provider's id (see the header). */
function asBuiltin(context: TranscriptContext, providerId: string, builtinId: string): TranscriptContext {
	if (!context.messages.some((message) => message.role === "assistant" && message.provider === providerId)) {
		return context;
	}
	const messages: Message[] = context.messages.map((message) =>
		message.role === "assistant" && message.provider === providerId ? { ...message, provider: builtinId } : message,
	);
	return { ...context, messages } as TranscriptContext;
}

function relabel(message: AssistantMessage | undefined, builtinId: string, providerId: string): void {
	if (message && message.provider === builtinId) message.provider = providerId;
}

/** HTTP status and the provider-shaped error's message, from a provider client's error text. */
function parseProviderError(text: string): { status?: number; message?: string; code?: string } {
	const brace = text.indexOf("{");
	// The status the client put before the body: digits inside the JSON (ids, counts) don't count.
	const head = brace >= 0 ? text.slice(0, brace) : text;
	const status = Number(head.match(/(?<![0-9])(401|403|404)(?![0-9])/)?.[1]) || undefined;
	const json = brace >= 0 ? text.slice(brace) : "";
	let message: string | undefined;
	let code: string | undefined;
	try {
		const body = JSON.parse(json) as Record<string, unknown>;
		const error = (Array.isArray(body) ? body[0]?.error : body.error) as Record<string, unknown> | undefined;
		if (error && typeof error.message === "string") message = error.message;
		if (error && typeof error.type === "string") code = error.type;
		if (error && typeof error.code === "string") code = error.code;
		if (error && typeof error.status === "string" && !code) code = error.status;
	} catch {
		// Not JSON: keep the client's text.
	}
	return { status, message, code };
}

/**
 * The message the person sees for a failed call through this connection: refusals (401, 403, 404) say which
 * connection and what to do; anything else is returned unchanged (undefined).
 */
export function connectionErrorText(name: string, errorMessage: string): string | undefined {
	const { status, message, code } = parseProviderError(errorMessage);
	if (!status) return undefined;
	const label = `Veyra model connection “${connectText(name)}”`;
	const detail = connectText(message ?? errorMessage).trim();
	if (status === 401) {
		return `${label}: Hands did not take your Veyra sign-in (${detail}). Run fingers login again.`;
	}
	if (status === 403 && (code === "max_cost_reached" || /cost cap/i.test(detail))) return `${label}: ${detail}`;
	if (status === 403) {
		return `${label}: refused (${detail}). Ask an admin of your organization in Connect: using a connection from Fingers needs Fingers cli:use and Connect models:use for your group, and the connection open to fingers and hands.`;
	}
	return `${label}: ${detail || "not found"}. It may have been removed in Connect; run /model to pick another.`;
}

function signInErrorText(name: string, error: unknown): string {
	const label = `Veyra model connection “${connectText(name)}”`;
	if (error instanceof VeyraSignedOutError) return `${label}: ${error.message}`;
	if (error instanceof VeyraAudienceError) {
		return `${label}: Connect gives this sign-in no Hands token (${connectText(error.message)}). Hands may be off for your organization.`;
	}
	return `${label}: could not get a Veyra token for Hands: ${connectText(error instanceof Error ? error.message : String(error))}`;
}

function failedMessage(model: Model<Api>, errorMessage: string, aborted: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: aborted ? "aborted" : "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

export interface ConnectionProviderOptions {
	offered: OfferedConnection;
	/** `<api>/hands/v1`. */
	handsApiBaseUrl: string;
	/** The models of the connection's built-in provider, as the runtime knows them now. */
	models: readonly Model<Api>[];
	token: HandsTokenSource;
	/** The built-in provider whose request code runs (tests pass a stub). Default: Fingers' own. */
	builtin?: Provider;
}

/** The provider of one offered connection, or undefined when Fingers has no built-in provider for it. */
export function createConnectionProvider(options: ConnectionProviderOptions): Provider | undefined {
	const { offered, token } = options;
	const builtinId = offered.route.fingersProvider;
	const builtin = options.builtin ?? builtinProvider(builtinId);
	if (!builtin) return undefined;
	const wire = offered.route.wire;
	const providerId = offered.providerId;
	const baseUrl = proxyBaseUrl(options.handsApiBaseUrl, offered.connection.id, wire);
	const name = offered.connection.name;
	const models = options.models
		.filter((model) => model.provider === builtinId)
		.map((model) => ({ ...model, provider: providerId, baseUrl }));

	const run = (
		model: Model<Api>,
		context: TranscriptContext,
		options: (StreamOptions & SimpleStreamOptions) | undefined,
		start: (model: Model<Api>, context: TranscriptContext, options: StreamOptions) => AssistantMessageEventStream,
	): AssistantMessageEventStream => {
		const out = createAssistantMessageEventStream();
		const signal = options?.signal;
		void (async () => {
			let bearer: string;
			try {
				bearer = await token(signal);
			} catch (error) {
				const aborted = signal?.aborted === true;
				const failed = failedMessage(model, signInErrorText(name, error), aborted);
				out.push({ type: "error", reason: aborted ? "aborted" : "error", error: failed });
				out.end();
				return;
			}
			try {
				const inner = start(
					{ ...model, provider: builtinId, baseUrl },
					asBuiltin(context, providerId, builtinId),
					authorized(options, wire, bearer),
				);
				for await (const event of inner as AsyncIterable<AssistantMessageEvent>) {
					if ("partial" in event) relabel(event.partial, builtinId, providerId);
					if (event.type === "done") relabel(event.message, builtinId, providerId);
					if (event.type === "error") {
						relabel(event.error, builtinId, providerId);
						const clear = event.error.errorMessage
							? connectionErrorText(name, event.error.errorMessage)
							: undefined;
						if (clear) event.error.errorMessage = clear;
					}
					out.push(event);
				}
				out.end();
			} catch (error) {
				const aborted = signal?.aborted === true;
				const text = error instanceof Error ? error.message : String(error);
				const failed = failedMessage(model, connectionErrorText(name, text) ?? text, aborted);
				out.push({ type: "error", reason: aborted ? "aborted" : "error", error: failed });
				out.end();
			}
		})();
		return out;
	};

	return createProvider({
		id: providerId,
		name: offered.displayName,
		baseUrl,
		auth: {
			apiKey: {
				name: "Veyra sign-in",
				// Configured while signed in; the token is fetched per request in `run`, never stored here.
				check: async () => ({ type: "api_key", source: "Veyra Connect" }),
				resolve: async () => ({ auth: {}, source: "Veyra Connect" }),
			},
		},
		models,
		api: {
			stream: (model, context, options) =>
				run(model, context, options, (m, c, o) => builtin.stream(m as never, c, o as never)),
			streamSimple: (model, context, options) =>
				run(model, context, options, (m, c, o) => builtin.streamSimple(m as never, c, o as SimpleStreamOptions)),
		},
	});
}

/** The part of VeyraAuth the set needs (tests pass a fake). */
export interface ConnectionsAuth extends ModelConnectionsSource {
	apiBaseUrl(app: "hands"): string;
	getAccessToken(app: "hands", options?: { signal?: AbortSignal }): Promise<string>;
}

/**
 * The process' Veyra model connections: the last list Connect gave for the signed-in organization, registered as
 * providers in every model runtime `apply()` sees. `load()` asks Connect again; `clear()` (sign-out) removes them.
 */
export class VeyraModelConnections {
	private current: { list: ModelConnectionsList; auth: ConnectionsAuth } | undefined;
	private readonly registered = new WeakMap<ModelRuntime, Set<string>>();
	private readonly runtimes = new Set<WeakRef<ModelRuntime>>();
	private readonly listeners = new Set<() => void>();

	/** The last list, or undefined before the first `load()` and after `clear()`. */
	get list(): ModelConnectionsList | undefined {
		return this.current?.list;
	}

	/** Ask Connect for the list (throws ModelConnectionsError, VeyraSignedOutError), then apply it everywhere. */
	async load(auth: ConnectionsAuth, options: { signal?: AbortSignal } = {}): Promise<ModelConnectionsList> {
		const list = await fetchModelConnections(auth, options);
		this.current = { list, auth };
		for (const ref of this.runtimes) {
			const runtime = ref.deref();
			if (runtime) this.apply(runtime);
			else this.runtimes.delete(ref);
		}
		for (const listener of this.listeners) listener();
		return list;
	}

	/** Register the offered connections in `runtime` (and drop ones no longer offered). Returns their provider ids. */
	apply(runtime: ModelRuntime): string[] {
		if (![...this.runtimes].some((ref) => ref.deref() === runtime)) this.runtimes.add(new WeakRef(runtime));
		const before = this.registered.get(runtime) ?? new Set<string>();
		const now = new Set<string>();
		const current = this.current;
		if (current) {
			const handsApiBaseUrl = current.auth.apiBaseUrl("hands");
			const token: HandsTokenSource = (signal) => current.auth.getAccessToken("hands", { signal });
			for (const offered of current.list.offered) {
				const provider = createConnectionProvider({
					offered,
					handsApiBaseUrl,
					models: runtime.getModels(offered.route.fingersProvider),
					token,
				});
				if (!provider || provider.getModels().length === 0) continue;
				runtime.registerNativeProvider(provider);
				now.add(provider.id);
			}
		}
		for (const id of before) if (!now.has(id) && isConnectionProviderId(id)) runtime.unregisterProvider(id);
		this.registered.set(runtime, now);
		return [...now];
	}

	/** `apply()`, then the runtime's availability check of those providers, so they count as configured right away. */
	async applyNow(runtime: ModelRuntime, signal?: AbortSignal): Promise<string[]> {
		const ids = this.apply(runtime);
		if (ids.length === 0) return ids;
		// registerNativeProvider() starts a full refresh of its own, whose availability pass discards a narrower one
		// that started earlier: wait for a full pass, then check the providers again until they count as configured.
		await runtime.refresh({ allowNetwork: false, signal });
		for (let attempt = 0; attempt < 3 && ids.some((id) => !runtime.hasConfiguredAuth(id)); attempt++) {
			await runtime.refresh({ allowNetwork: false, providers: ids, signal });
		}
		return ids;
	}

	/** Sign-out: no connection stays registered in any runtime. */
	clear(): void {
		this.current = undefined;
		for (const ref of this.runtimes) {
			const runtime = ref.deref();
			if (runtime) this.apply(runtime);
		}
		for (const listener of this.listeners) listener();
	}

	/** Called after every `load()` and `clear()`. Returns the function that stops it. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

export const veyraModelConnections = new VeyraModelConnections();

export interface PrepareModelConnectionsOptions {
	/** The sign-in, opened only when needed (a start without a sign-in never touches the keychain). */
	auth: () => ConnectionsAuth | undefined;
	/**
	 * Whether this start needs the connections before it picks a model: the saved default, `--model`/`--provider`/
	 * `--models` or the resumed session names a Veyra connection. Otherwise the interactive app loads them after its
	 * first frame.
	 */
	wanted: boolean;
	/** FINGERS_OFFLINE / `--offline`: no request. */
	offline: boolean;
	timeoutMs?: number;
}

/**
 * At start, for each model runtime (start, /new, /resume, /fork): register the connections this process already
 * knows; when the start needs them and none are known, ask Connect first (bounded by `timeoutMs`). Returns a warning
 * for the start's diagnostics when Connect could not answer.
 */
export async function prepareModelConnections(
	runtime: ModelRuntime,
	options: PrepareModelConnectionsOptions,
	connections: VeyraModelConnections = veyraModelConnections,
): Promise<string | undefined> {
	if (connections.list || !options.wanted || options.offline) {
		await connections.applyNow(runtime);
		return undefined;
	}
	connections.apply(runtime);
	let auth: ConnectionsAuth | undefined;
	try {
		auth = options.auth();
		if (!auth?.account()) return undefined;
		const signal = AbortSignal.timeout(options.timeoutMs ?? 8_000);
		await connections.load(auth, { signal });
		await connections.applyNow(runtime, signal);
		return undefined;
	} catch (error) {
		return `Veyra model connections not loaded: ${connectText(error instanceof Error ? error.message : String(error))}`;
	}
}

/** True when a provider/model reference, pattern or session answer names a Veyra connection. */
export function namesModelConnection(values: ReadonlyArray<string | undefined>): boolean {
	return values.some((value) => value !== undefined && /(^|[\s,/])veyra-/.test(value));
}
