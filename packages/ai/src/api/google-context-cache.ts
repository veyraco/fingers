/**
 * Gemini context caching (explicit caches, `cachedContents`).
 *
 * Gemini 2.5 and later cache repeated prompt prefixes by themselves (implicit caching), which is what
 * short retention relies on: Fingers keeps the system instruction, the tools and the earlier contents
 * byte-identical from turn to turn so the implicit cache can match. Long retention adds an explicit
 * context cache for the part that never changes within a session, the system instruction plus the tool
 * declarations: it is created once (TTL one hour), every request names it in `cachedContent` and then
 * leaves those fields out, so the cached rate applies on every turn instead of only when the implicit
 * cache happens to hit. The storage is billed per hour by Google, which is why it is opt-in.
 *
 * A prefix too small to cache is not sent (estimated size), and a refusal or an expired cache never
 * fails the request: it is sent without the cache.
 */
import type {
	CreateCachedContentConfig,
	GenerateContentConfig,
	GenerateContentParameters,
	GoogleGenAI,
} from "@google/genai";
import type { CacheRetention, Model } from "../types.ts";
import { shortHash } from "../utils/hash.ts";

/** Smallest context Gemini caches (Gemini 2.5 Flash). Larger models need more; the API refuses those. */
const MIN_CACHEABLE_TOKENS = 1024;
/** Rough size estimate of the serialized prefix, only used to skip prefixes that are clearly too small. */
const CHARS_PER_TOKEN = 4;
const LONG_TTL_SECONDS = 3600;
/** A cache this close to its expiry is replaced, so a request never races the expiry. */
const EXPIRY_MARGIN_MS = 60_000;
/** After the API refused to cache a prefix (too small for the model, model without caching), wait this long. */
const REFUSAL_BACKOFF_MS = 10 * 60_000;
const MAX_ENTRIES = 64;

interface CacheEntry {
	/** The `cachedContents/...` resource name; undefined while a refusal backs off. */
	name?: string;
	expiresAt: number;
}

const entries = new Map<string, Promise<CacheEntry>>();

/** Drops every remembered cache (tests, and a new process state). The caches on Google's side expire by TTL. */
export function resetGeminiContextCaches(): void {
	entries.clear();
}

type CachedFields = Pick<CreateCachedContentConfig, "systemInstruction" | "tools" | "toolConfig">;

function cachedFields(config: GenerateContentConfig | undefined): CachedFields | undefined {
	if (!config || (!config.systemInstruction && !config.tools?.length)) return undefined;
	// A cache holds plain tool declarations only; requests that carry SDK-side callable tools go uncached.
	const tools = config.tools;
	if (tools?.some((tool) => !isDeclaredTool(tool))) return undefined;
	return {
		...(config.systemInstruction !== undefined && { systemInstruction: config.systemInstruction }),
		...(tools !== undefined && { tools: tools.filter(isDeclaredTool) }),
		...(config.toolConfig !== undefined && { toolConfig: config.toolConfig }),
	};
}

type ToolEntry = NonNullable<GenerateContentConfig["tools"]>[number];
type DeclaredTool = NonNullable<CreateCachedContentConfig["tools"]>[number];

function isDeclaredTool(tool: ToolEntry): tool is DeclaredTool {
	return !("callTool" in tool);
}

function remember(key: string, entry: Promise<CacheEntry>): void {
	entries.delete(key);
	entries.set(key, entry);
	if (entries.size > MAX_ENTRIES) {
		const oldest = entries.keys().next().value;
		if (oldest !== undefined) entries.delete(oldest);
	}
}

async function createCache(
	client: GoogleGenAI,
	model: Model<"google-generative-ai">,
	fields: CachedFields,
	signal: AbortSignal | undefined,
	onRefused: ((error: unknown) => void) | undefined,
): Promise<CacheEntry> {
	try {
		const created = await client.caches.create({
			model: model.id,
			config: {
				...fields,
				ttl: `${LONG_TTL_SECONDS}s`,
				displayName: "fingers",
				...(signal && { abortSignal: signal }),
			},
		});
		if (!created.name) return { expiresAt: Date.now() + REFUSAL_BACKOFF_MS };
		const expireTime = created.expireTime ? Date.parse(created.expireTime) : Number.NaN;
		return {
			name: created.name,
			expiresAt: Number.isFinite(expireTime) ? expireTime : Date.now() + LONG_TTL_SECONDS * 1000,
		};
	} catch (error) {
		// Too small for this model, a model without explicit caching, or a transient failure: the
		// request goes out uncached, and this prefix is not offered again for a while.
		onRefused?.(error);
		return { expiresAt: Date.now() + REFUSAL_BACKOFF_MS };
	}
}

export interface GeminiContextCacheUse {
	/** The request naming the cache, without the fields the cache holds. */
	params: GenerateContentParameters;
	key: string;
}

/**
 * With long retention, returns the request rewritten to use an explicit context cache holding its
 * system instruction and tools (created on first use, then reused until shortly before it expires).
 * Returns undefined when the request goes out as built: other retention, nothing to cache, a prefix
 * too small, or the API refused the cache.
 */
export async function applyGeminiContextCache(
	client: GoogleGenAI,
	model: Model<"google-generative-ai">,
	params: GenerateContentParameters,
	options: {
		apiKey: string;
		cacheRetention: CacheRetention;
		signal?: AbortSignal;
		/** Called when this request asked for the cache and the API refused it. */
		onRefused?: (error: unknown) => void;
	},
): Promise<GeminiContextCacheUse | undefined> {
	if (options.cacheRetention !== "long") return undefined;
	const fields = cachedFields(params.config);
	if (!fields) return undefined;
	const serialized = JSON.stringify(fields);
	if (serialized.length / CHARS_PER_TOKEN < MIN_CACHEABLE_TOKENS) return undefined;

	// A cache belongs to the key's project and to one model; the key only enters an in-memory hash.
	const key = shortHash(`${model.baseUrl}\n${shortHash(options.apiKey)}\n${model.id}\n${serialized}`);
	let pending = entries.get(key);
	if (pending) {
		const entry = await pending;
		if (entry.expiresAt - EXPIRY_MARGIN_MS <= Date.now()) pending = undefined;
	}
	if (!pending) {
		pending = createCache(client, model, fields, options.signal, options.onRefused);
		remember(key, pending);
	}
	const entry = await pending;
	if (!entry.name) {
		// An aborted request says nothing about the prefix: let the next one try again.
		if (options.signal?.aborted) forgetGeminiContextCache(key);
		return undefined;
	}

	const { systemInstruction: _system, tools: _tools, toolConfig: _toolConfig, ...rest } = params.config ?? {};
	return { key, params: { ...params, config: { ...rest, cachedContent: entry.name } } };
}

/** Forgets a cache the API no longer accepts (expired early, deleted), so the next request creates a new one. */
export function forgetGeminiContextCache(key: string): void {
	entries.delete(key);
}

/** True when a request failed because of the cache it named, so it can be sent once more without it. */
export function isCachedContentError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const status = (error as { status?: unknown }).status;
	if (status !== 400 && status !== 403 && status !== 404) return false;
	return /cached\s*content/i.test(error.message);
}
