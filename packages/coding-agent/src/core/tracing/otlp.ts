/**
 * The generic OTLP exporter (open core, F21): sends Fingers' spans to any OpenTelemetry collector or backend as
 * OTLP/HTTP JSON (`POST <endpoint>/v1/traces`). It batches, never blocks the session and drops what it cannot send.
 *
 * It is off unless the person configures it (FINGERS_OTLP_ENDPOINT); Fingers never sends telemetry on its own. ee's
 * Eyes feed uses the same exporter with the signed-in person's token.
 */
import type { FingersSpan, SpanAttributes, SpanAttributeValue, SpanExporter, SpanKind } from "./spans.ts";

const KIND: Record<SpanKind, number> = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 };
const STATUS = { unset: 0, ok: 1, error: 2 } as const;

type AnyValue =
	| { stringValue: string }
	| { boolValue: boolean }
	| { intValue: string }
	| { doubleValue: number }
	| { arrayValue: { values: AnyValue[] } };

function anyValue(value: SpanAttributeValue): AnyValue {
	if (Array.isArray(value)) return { arrayValue: { values: value.map((item) => anyValue(item)) } };
	if (typeof value === "string") return { stringValue: value };
	if (typeof value === "boolean") return { boolValue: value };
	return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}

function keyValues(attributes: SpanAttributes): Array<{ key: string; value: AnyValue }> {
	return Object.entries(attributes).map(([key, value]) => ({ key, value: anyValue(value) }));
}

/** An OTLP/JSON ExportTraceServiceRequest for these spans (ids as lowercase hex, times as decimal strings). */
export function otlpTraceRequest(
	spans: readonly FingersSpan[],
	resource: SpanAttributes,
	scope: { name: string; version?: string },
): Record<string, unknown> {
	return {
		resourceSpans: [
			{
				resource: { attributes: keyValues(resource) },
				scopeSpans: [
					{
						scope: { name: scope.name, ...(scope.version ? { version: scope.version } : {}) },
						spans: spans.map((span) => ({
							traceId: span.trace_id,
							spanId: span.span_id,
							...(span.parent_span_id ? { parentSpanId: span.parent_span_id } : {}),
							name: span.name,
							kind: KIND[span.kind],
							startTimeUnixNano: span.start_time_unix_nano,
							endTimeUnixNano: span.end_time_unix_nano,
							attributes: keyValues(span.attributes),
							status: {
								code: STATUS[span.status.code],
								...(span.status.message ? { message: span.status.message } : {}),
							},
						})),
					},
				],
			},
		],
	};
}

export interface OtlpExporterOptions {
	/** The traces URL (`…/v1/traces`). */
	url: string;
	/** Request headers, asked for every batch (a fresh access token); a throw drops the batch. */
	headers?: () => Record<string, string> | Promise<Record<string, string>>;
	/** Resource attributes (`service.name` defaults to `fingers`). */
	resource?: SpanAttributes;
	/** The Fingers version, for `service.version` and the instrumentation scope. */
	version?: string;
	/** Takes payloads (SpanExporter.content). Default false. */
	content?: boolean;
	/** Asked before each batch goes out; false drops it (the sign-in moved to another organization). */
	allowSend?: () => boolean;
	fetch?: typeof fetch;
	maxBatch?: number;
	maxQueue?: number;
	flushIntervalMs?: number;
	timeoutMs?: number;
	/** Told about every batch that was dropped or refused; the session goes on. */
	onError?: (error: unknown) => void;
}

export class OtlpHttpExporter implements SpanExporter {
	readonly content: boolean;
	private readonly options: OtlpExporterOptions;
	private queue: FingersSpan[] = [];
	private timer?: ReturnType<typeof setTimeout>;
	private sending: Promise<void> = Promise.resolve();
	/** Spans dropped because the queue was full, since the last report. */
	private dropped = 0;

	constructor(options: OtlpExporterOptions) {
		this.options = options;
		this.content = options.content === true;
	}

	private get maxBatch(): number {
		return this.options.maxBatch ?? 64;
	}

	export(span: FingersSpan): void {
		if (this.queue.length >= (this.options.maxQueue ?? 2048)) {
			this.dropped++;
			return;
		}
		this.queue.push(span);
		if (this.queue.length >= this.maxBatch) {
			void this.flush();
			return;
		}
		if (!this.timer) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				void this.flush();
			}, this.options.flushIntervalMs ?? 5_000);
			this.timer.unref?.();
		}
	}

	/** Send everything queued now; resolves when it went out or was dropped. Never rejects. */
	flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const spans = this.queue;
		this.queue = [];
		if (this.dropped > 0) {
			this.options.onError?.(new Error(`OTLP queue full: ${this.dropped} spans dropped`));
			this.dropped = 0;
		}
		if (spans.length === 0) return this.sending;
		const batches: FingersSpan[][] = [];
		for (let index = 0; index < spans.length; index += this.maxBatch) {
			batches.push(spans.slice(index, index + this.maxBatch));
		}
		this.sending = this.sending.then(async () => {
			for (const batch of batches) await this.send(batch);
		});
		return this.sending;
	}

	private async send(batch: FingersSpan[]): Promise<void> {
		try {
			if (this.options.allowSend && !this.options.allowSend()) {
				throw new Error(`OTLP batch of ${batch.length} spans dropped: no longer allowed to send it`);
			}
			const headers = (await this.options.headers?.()) ?? {};
			const body = otlpTraceRequest(
				batch,
				{
					"service.name": "fingers",
					...(this.options.version ? { "service.version": this.options.version } : {}),
					...this.options.resource,
				},
				{ name: "fingers", version: this.options.version },
			);
			// The token may have been fetched for another organization while we waited for it.
			if (this.options.allowSend && !this.options.allowSend()) {
				throw new Error(`OTLP batch of ${batch.length} spans dropped: no longer allowed to send it`);
			}
			const response = await (this.options.fetch ?? fetch)(this.options.url, {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
			});
			if (!response.ok) throw new Error(`OTLP export refused: HTTP ${response.status}`);
			await response.body?.cancel().catch(() => {});
		} catch (error) {
			this.options.onError?.(error);
		}
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Configuration from the environment
// ---------------------------------------------------------------------------------------------------------------

export interface OtlpEnvConfig {
	url: string;
	headers: Record<string, string>;
	content: boolean;
}

function truthy(value: string | undefined): boolean {
	return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * The person's own OTLP destination: FINGERS_OTLP_TRACES_ENDPOINT (the full traces URL) or FINGERS_OTLP_ENDPOINT (a
 * base, `/v1/traces` added), FINGERS_OTLP_HEADERS (`name=value,name=value`, values URL-encoded like
 * OTEL_EXPORTER_OTLP_HEADERS) and FINGERS_OTLP_CAPTURE_CONTENT=1 for payloads. Undefined when none is set; throws on
 * a URL that is not http(s).
 */
export function otlpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OtlpEnvConfig | undefined {
	const traces = env.FINGERS_OTLP_TRACES_ENDPOINT?.trim();
	const base = env.FINGERS_OTLP_ENDPOINT?.trim();
	if (!traces && !base) return undefined;
	const url = traces || `${base!.replace(/\/+$/, "")}/v1/traces`;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`FINGERS_OTLP endpoint is not a URL: ${url}`);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error(`FINGERS_OTLP endpoint must be http(s): ${url}`);
	}
	const headers: Record<string, string> = {};
	for (const pair of (env.FINGERS_OTLP_HEADERS ?? "").split(",")) {
		const index = pair.indexOf("=");
		if (index <= 0) continue;
		const name = pair.slice(0, index).trim();
		let value = pair.slice(index + 1).trim();
		try {
			value = decodeURIComponent(value);
		} catch {
			// Kept as written.
		}
		if (name) headers[name] = value;
	}
	return { url: parsed.toString(), headers, content: truthy(env.FINGERS_OTLP_CAPTURE_CONTENT) };
}
