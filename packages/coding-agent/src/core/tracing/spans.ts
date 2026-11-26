/**
 * Telemetry spans (open core, F21): the OTLP-shaped span Fingers produces for its model calls, tool calls and
 * compactions, following the OpenTelemetry GenAI semantic conventions (`gen_ai.*`) and Veyra's attribute registry
 * (`veyra.*`, platform contracts/v1/eyes-feed.md). The same shape travels as a Fingers RPC v1 `telemetry_span` record
 * (managed mode) and goes into OTLP/HTTP JSON for an exporter (otlp.ts).
 *
 * Masking (maskSpan) runs on every span before any sink sees it: attributes named like a credential are dropped and
 * every string value is cleared of credential-shaped text and of the secrets the caller knows (managed mode: the model
 * credential and credential headers the host sent).
 */

export type SpanAttributeScalar = string | number | boolean;
export type SpanAttributeValue = SpanAttributeScalar | SpanAttributeScalar[];
export type SpanAttributes = Record<string, SpanAttributeValue>;

export type SpanKind = "internal" | "client" | "server" | "producer" | "consumer";

export interface SpanStatus {
	code: "unset" | "ok" | "error";
	/** At most 2,000 characters (the RPC contract's limit). */
	message?: string;
}

/** One finished span, as the RPC v1 contract's `telemetry_span.span`. */
export interface FingersSpan {
	trace_id: string;
	span_id: string;
	parent_span_id?: string;
	name: string;
	kind: SpanKind;
	/** Decimal strings (nanoseconds since the epoch). */
	start_time_unix_nano: string;
	end_time_unix_nano: string;
	attributes: SpanAttributes;
	status: SpanStatus;
}

/** Where finished spans go: the RPC relay, an OTLP exporter, Eyes. */
export interface SpanExporter {
	/**
	 * This exporter takes payloads (prompts, answers, system instructions, tool arguments and results, provider error
	 * text). Default false: it gets every span without them.
	 */
	readonly content?: boolean;
	export(span: FingersSpan): void;
	/** Send what is queued now (a run ended, the session shuts down). */
	flush?(): Promise<void>;
	/** The console link of the last run's trace, when the destination has a console (Eyes); the savings report shows it. */
	lastTraceLink?(): string | undefined;
}

/** Nanoseconds since the epoch, as a decimal string, for a time in milliseconds. */
export function unixNano(ms: number): string {
	return (BigInt(Math.max(0, Math.round(ms * 1000))) * 1000n).toString();
}

/**
 * `gen_ai.provider.name` for a Fingers provider id: the GenAI conventions' well-known value where there is one,
 * otherwise the Fingers id itself.
 */
export function genAiProviderName(provider: string): string {
	const id = provider.toLowerCase();
	if (id === "anthropic" || id === "openai" || id === "deepseek" || id === "groq" || id === "cohere") return id;
	if (id === "perplexity") return "perplexity";
	if (id === "google" || id === "google-gemini-cli" || id === "gemini") return "gcp.gemini";
	if (id.startsWith("google-vertex") || id === "vertex" || id === "vertex-anthropic") return "gcp.vertex_ai";
	if (id === "amazon-bedrock" || id === "bedrock") return "aws.bedrock";
	if (id === "xai") return "x_ai";
	if (id === "mistral") return "mistral_ai";
	if (id.startsWith("azure-openai") || id === "azure") return "azure.ai.openai";
	return id;
}

/** `gen_ai.response.finish_reasons` for a Fingers stop reason. */
export function finishReason(stopReason: string | undefined): string {
	switch (stopReason) {
		case "toolUse":
			return "tool_call";
		case "length":
			return "length";
		case "error":
			return "error";
		case "aborted":
			return "cancelled";
		default:
			return "stop";
	}
}

/** Why a model call failed, as a short `error.type` / `veyra.retry.reason` value. Never the error text itself. */
export function modelErrorType(message: string | undefined): string {
	const text = (message ?? "").toLowerCase();
	if (/\b429\b|rate.?limit|too many requests/.test(text)) return "rate_limited";
	if (/\b529\b|overloaded|\b503\b|unavailable/.test(text)) return "overloaded";
	if (/timed? ?out|timeout|etimedout|econnreset|socket hang up/.test(text)) return "timeout";
	if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid.{0,20}(api.?key|token|credential)|expired/.test(text)) {
		return "credentials";
	}
	if (/context.{0,20}(length|window|overflow)|too long|prompt is too long/.test(text)) return "context_overflow";
	return "provider_error";
}

/** The payload attributes (platform eyes-feed.md, Payload attributes) a span may carry with content capture on. */
export const PAYLOAD_ATTRIBUTES = [
	"gen_ai.input.messages",
	"gen_ai.output.messages",
	"gen_ai.system_instructions",
	"gen_ai.tool.call.arguments",
	"gen_ai.tool.call.result",
] as const;

/** The span without payloads: no payload attribute and no status message (a provider's error text). */
export function withoutPayload(span: FingersSpan): FingersSpan {
	const attributes: SpanAttributes = { ...span.attributes };
	for (const name of PAYLOAD_ATTRIBUTES) delete attributes[name];
	return { ...span, attributes, status: { code: span.status.code } };
}

// ---------------------------------------------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------------------------------------------

const REDACTED = "[redacted]";

/**
 * Credential-shaped text, with well-known prefixes only (so ordinary text stays readable): provider keys, GitHub,
 * Slack, AWS and Google keys, bearer tokens, JWTs and private keys.
 */
const CREDENTIAL_PATTERNS: RegExp[] = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\bsk-ant-[A-Za-z0-9_-]{16,}/g,
	/\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{20,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\bAIza[0-9A-Za-z_-]{35}\b/g,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
	/\b([Bb]earer|[Bb]asic)\s+[A-Za-z0-9._~+/-]{16,}=*/g,
];

/** Attribute names (their last segment) that carry a credential: such an attribute never leaves. */
const CREDENTIAL_NAME =
	/(^|[._])(authorization|proxy_authorization|cookie|set_cookie|api_key|apikey|password|passwd|secret|client_secret|credential|credentials|access_token|refresh_token|id_token|private_key)$/;

/** `text` without credential-shaped substrings. */
export function redactCredentials(text: string): string {
	let result = text;
	for (const pattern of CREDENTIAL_PATTERNS) {
		pattern.lastIndex = 0;
		if (pattern.test(result)) {
			pattern.lastIndex = 0;
			result = result.replace(pattern, (_match, scheme?: string) =>
				typeof scheme === "string" && /^(bearer|basic)$/i.test(scheme) ? `${scheme} ${REDACTED}` : REDACTED,
			);
		}
	}
	return result;
}

export interface MaskOptions {
	/** Removes the secrets the caller knows (managed mode: the host's credential and header values). */
	redactSecrets?: (text: string) => string;
}

/** `text` without the caller's known secrets and credential-shaped substrings. */
export function maskText(text: string, options: MaskOptions = {}): string {
	const known = options.redactSecrets ? options.redactSecrets(text) : text;
	return redactCredentials(known);
}

/**
 * The span as it may leave Fingers: credential-named attributes dropped, every string (attribute values, array items,
 * the status message, the name) cleared of known secrets and credential-shaped text.
 */
export function maskSpan(span: FingersSpan, options: MaskOptions = {}): FingersSpan {
	const attributes: SpanAttributes = {};
	for (const [name, value] of Object.entries(span.attributes)) {
		if (CREDENTIAL_NAME.test(name.toLowerCase())) continue;
		if (typeof value === "string") attributes[name] = maskText(value, options);
		else if (Array.isArray(value))
			attributes[name] = value.map((item) => (typeof item === "string" ? maskText(item, options) : item));
		else attributes[name] = value;
	}
	return {
		...span,
		name: maskText(span.name, options),
		attributes,
		status: span.status.message ? { ...span.status, message: maskText(span.status.message, options) } : span.status,
	};
}
