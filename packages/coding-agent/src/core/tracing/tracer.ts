/**
 * The session tracer (open core, F21): turns what a session does into GenAI spans.
 *
 * - A model call is a `chat` span (`gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.id`,
 *   `gen_ai.response.finish_reasons`, `gen_ai.usage.*` with the cache tokens, `gen_ai.conversation.id`). A failed
 *   call has status `error` with an `error.type`; a call made again after a failure carries `veyra.retry.attempt`
 *   (the first call is attempt 1) and `veyra.retry.reason`.
 * - A tool call is an `execute_tool` span (`gen_ai.tool.name`, `gen_ai.tool.call.id`).
 * - A compaction is a `veyra.compaction` span with `veyra.compaction.tokens_before` and `.tokens_after` (the RPC
 *   contract's `telemetry_span` carries no span events, so it is a short span of its own).
 * - With a parent trace (managed mode: the trace of the command that started the run), every span is a child of it and
 *   a model call's span id is the one the model request carries in its `traceparent`. Without one (the terminal app),
 *   each run is a trace of its own: an `invoke_agent` span from the run's start to its end, parent of the others.
 * - Prompts, answers, system instructions and tool arguments and results go into spans only while an exporter takes
 *   content (SpanExporter.content); every other exporter gets the same span without them.
 *
 * Every span is masked (spans.ts) before an exporter sees it.
 */
import type { AgentMessage } from "@veyraco/fingers-agent";
import type { AssistantMessage } from "@veyraco/fingers-ai";
import { childSpan, newSpanId, type TraceContext } from "../trace-context.ts";
import {
	boundedJson,
	boundedText,
	MAX_PAYLOAD_CHARS,
	messagesPayload,
	toGenAiMessage,
	toolResultText,
} from "./content.ts";
import {
	type FingersSpan,
	finishReason,
	genAiProviderName,
	type MaskOptions,
	maskSpan,
	maskText,
	modelErrorType,
	type SpanAttributes,
	type SpanExporter,
	unixNano,
	withoutPayload,
} from "./spans.ts";

export interface SessionTracerOptions {
	/** The exporters spans go to right now; none: no spans are made. Asked when a run starts and as each span ends. */
	exporters(): readonly SpanExporter[];
	/** The trace to continue (managed mode); undefined: each run starts its own trace with an `invoke_agent` span. */
	parent?(): TraceContext | undefined;
	/** Attributes every span gets (managed: `veyra.run_id`, `veyra.fingers.agent_id`, `veyra.correlation_id`). */
	attributes?(): SpanAttributes;
	/** The conversation id (`gen_ai.conversation.id`): the Fingers session id. */
	conversationId?(): string | undefined;
	/** For content capture: the system prompt of the call and the transcript it was sent. */
	systemPrompt?(): string | undefined;
	messages?(): readonly AgentMessage[];
	/** Masking beyond the built-in credential patterns (managed: the host's secrets). */
	mask?: MaskOptions;
	/** Told when an exporter throws; the session goes on. */
	onError?(error: unknown): void;
	/** Clock in epoch milliseconds (tests). */
	now?(): number;
}

interface OpenRun {
	/** The run's trace and its `invoke_agent` span (local mode only). */
	root?: TraceContext;
	startedAt: number;
	/** The last model call of the run failed: the next one is a retry of it. */
	failed?: { attempt: number; reason: string };
}

interface PendingCall {
	context: TraceContext;
	startedAt: number;
}

interface OpenTool {
	context: TraceContext;
	startedAt: number;
	name: string;
	args: unknown;
}

export class SessionTracer {
	private readonly options: SessionTracerOptions;
	private run?: OpenRun;
	/** The model request sent last and not answered yet (its span id is in the request's `traceparent`). */
	private pending?: PendingCall;
	private assistantStartedAt?: number;
	private readonly tools = new Map<string, OpenTool>();

	constructor(options: SessionTracerOptions) {
		this.options = options;
	}

	/** Payloads are masked whole before they are cut to size (maskSpan then masks the span as a whole). */
	private readonly mask = (text: string): string => maskText(text, this.options.mask);

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private active(): boolean {
		try {
			return this.options.exporters().length > 0;
		} catch (error) {
			this.options.onError?.(error);
			return false;
		}
	}

	/** Some exporter takes payloads right now. */
	private capture(): boolean {
		try {
			return this.options.exporters().some((exporter) => exporter.content === true);
		} catch {
			return false;
		}
	}

	/** The parent of a new span: the run's `invoke_agent` span, or the trace to continue. */
	private parentContext(): TraceContext | undefined {
		return this.run?.root ?? this.options.parent?.();
	}

	private newContext(): TraceContext {
		const parent = this.parentContext();
		if (parent) return childSpan(parent);
		// Neither a run nor a parent (a call outside a run): a trace of its own.
		return { traceId: newTraceIdFrom(), spanId: newSpanId(), flags: "01" };
	}

	/** A run started (the first `agent_start` until it settles). */
	runStarted(): void {
		if (this.run) return;
		if (!this.active()) return;
		const startedAt = this.now();
		const parent = this.options.parent?.();
		this.run = {
			startedAt,
			root: parent ? undefined : { traceId: newTraceIdFrom(), spanId: newSpanId(), flags: "01" },
		};
	}

	/**
	 * A model request is about to go out: the span context its `traceparent` header carries (the `chat` span's own),
	 * or undefined when no span is made. Managed mode always gets a context, so the request is correlated even without
	 * telemetry.
	 */
	modelRequest(): TraceContext | undefined {
		if (!this.run && !this.active()) return undefined;
		const context = this.newContext();
		this.pending = { context, startedAt: this.now() };
		return context;
	}

	/** The assistant message of a model call started streaming. */
	assistantStarted(): void {
		this.assistantStartedAt = this.now();
	}

	/** A model call finished (its assistant message is complete: answered, failed or aborted). */
	assistantEnded(message: AssistantMessage): void {
		const pending = this.pending;
		this.pending = undefined;
		const startedAt = pending?.startedAt ?? this.assistantStartedAt ?? this.now();
		this.assistantStartedAt = undefined;
		const run = this.run;
		if (!run && !this.active()) return;
		const context = pending?.context ?? this.newContext();
		const usage = message.usage;
		const attributes: SpanAttributes = {
			"gen_ai.operation.name": "chat",
			"gen_ai.provider.name": genAiProviderName(message.provider),
			"gen_ai.request.model": message.model,
			"gen_ai.response.finish_reasons": [finishReason(message.stopReason)],
		};
		if (message.responseModel) attributes["gen_ai.response.model"] = message.responseModel;
		if (message.responseId) attributes["gen_ai.response.id"] = message.responseId;
		if (usage) {
			const cacheRead = usage.cacheRead ?? 0;
			const cacheWrite = usage.cacheWrite ?? 0;
			// The GenAI conventions count cached tokens inside the input tokens; Fingers' `input` is the uncached part.
			attributes["gen_ai.usage.input_tokens"] = (usage.input ?? 0) + cacheRead + cacheWrite;
			attributes["gen_ai.usage.output_tokens"] = usage.output ?? 0;
			if (cacheRead > 0) attributes["gen_ai.usage.cache_read.input_tokens"] = cacheRead;
			if (cacheWrite > 0) attributes["gen_ai.usage.cache_creation.input_tokens"] = cacheWrite;
		}
		const conversation = this.options.conversationId?.();
		if (conversation) attributes["gen_ai.conversation.id"] = conversation;
		const failed = message.stopReason === "error";
		const errorType = failed ? modelErrorType(message.errorMessage) : undefined;
		if (run?.failed) {
			attributes["veyra.retry.attempt"] = run.failed.attempt + 1;
			attributes["veyra.retry.reason"] = run.failed.reason;
		}
		if (run) {
			const attempt = run.failed ? run.failed.attempt + 1 : 1;
			run.failed = failed ? { attempt, reason: errorType! } : undefined;
		}
		if (errorType) attributes["error.type"] = errorType;
		const capture = this.capture();
		if (capture) {
			const system = this.options.systemPrompt?.();
			if (system) attributes["gen_ai.system_instructions"] = boundedText(system, MAX_PAYLOAD_CHARS, this.mask);
			const transcript = this.options.messages?.() ?? [];
			// The call's input: the transcript before this answer.
			const end = transcript.lastIndexOf(message as unknown as AgentMessage);
			const input = messagesPayload(end >= 0 ? transcript.slice(0, end) : transcript);
			if (input) attributes["gen_ai.input.messages"] = input;
			const output = toGenAiMessage(message as unknown as AgentMessage);
			if (output)
				attributes["gen_ai.output.messages"] = boundedText(JSON.stringify([output]), MAX_PAYLOAD_CHARS, this.mask);
		}
		this.finish({
			context,
			name: `chat ${message.model}`,
			kind: "client",
			startedAt,
			attributes,
			// The provider's error text may quote the request: only with content capture; otherwise `error.type` says why.
			status: failed
				? capture && message.errorMessage
					? { code: "error", message: boundedText(message.errorMessage, 500, this.mask) }
					: { code: "error" }
				: { code: message.stopReason === "aborted" ? "unset" : "ok" },
		});
	}

	toolStarted(toolCallId: string, name: string, args: unknown): void {
		if (!this.run && !this.active()) return;
		this.tools.set(toolCallId, { context: this.newContext(), startedAt: this.now(), name, args });
	}

	toolEnded(toolCallId: string, name: string, result: unknown, isError: boolean): void {
		const open = this.tools.get(toolCallId);
		this.tools.delete(toolCallId);
		if (!open) return;
		const attributes: SpanAttributes = {
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": name || open.name,
			"gen_ai.tool.call.id": toolCallId,
			"gen_ai.tool.type": name.startsWith("mcp__") ? "extension" : "function",
		};
		const conversation = this.options.conversationId?.();
		if (conversation) attributes["gen_ai.conversation.id"] = conversation;
		if (isError) attributes["error.type"] = "tool_error";
		if (this.capture()) {
			attributes["gen_ai.tool.call.arguments"] = boundedJson(open.args, this.mask);
			attributes["gen_ai.tool.call.result"] = toolResultText(result, this.mask);
		}
		this.finish({
			context: open.context,
			name: `execute_tool ${name || open.name}`,
			kind: "internal",
			startedAt: open.startedAt,
			attributes,
			status: isError ? { code: "error" } : { code: "ok" },
		});
	}

	/** A compaction finished (tokens of the context before it, and after it when known). */
	compacted(tokensBefore: number, tokensAfter: number | undefined, startedAt?: number): void {
		if (!this.run && !this.active()) return;
		const attributes: SpanAttributes = { "veyra.compaction.tokens_before": Math.max(0, Math.round(tokensBefore)) };
		if (tokensAfter !== undefined) attributes["veyra.compaction.tokens_after"] = Math.max(0, Math.round(tokensAfter));
		const conversation = this.options.conversationId?.();
		if (conversation) attributes["gen_ai.conversation.id"] = conversation;
		this.finish({
			context: this.newContext(),
			name: "veyra.compaction",
			kind: "internal",
			startedAt: startedAt ?? this.now(),
			attributes,
			status: { code: "ok" },
		});
	}

	/** The run settled: its `invoke_agent` span ends (local mode); tool calls left open are dropped. */
	runSettled(aborted: boolean): void {
		const run = this.run;
		this.run = undefined;
		this.pending = undefined;
		this.tools.clear();
		if (!run?.root) return;
		const attributes: SpanAttributes = {
			"gen_ai.operation.name": "invoke_agent",
			"gen_ai.agent.name": "fingers",
		};
		const conversation = this.options.conversationId?.();
		if (conversation) attributes["gen_ai.conversation.id"] = conversation;
		const failed = run.failed !== undefined;
		if (failed) attributes["error.type"] = run.failed!.reason;
		this.finish({
			context: run.root,
			name: "invoke_agent fingers",
			kind: "internal",
			startedAt: run.startedAt,
			attributes,
			status: failed ? { code: "error" } : { code: aborted ? "unset" : "ok" },
		});
	}

	private finish(span: {
		context: TraceContext;
		name: string;
		kind: FingersSpan["kind"];
		startedAt: number;
		attributes: SpanAttributes;
		status: FingersSpan["status"];
	}): void {
		let exporters: readonly SpanExporter[];
		try {
			exporters = this.options.exporters();
		} catch (error) {
			this.options.onError?.(error);
			return;
		}
		if (exporters.length === 0) return;
		const endedAt = Math.max(this.now(), span.startedAt);
		const raw: FingersSpan = {
			trace_id: span.context.traceId,
			span_id: span.context.spanId,
			...(span.context.parentSpanId ? { parent_span_id: span.context.parentSpanId } : {}),
			// Masked before the cut, like payloads (maskSpan masks it again, which changes nothing).
			name: this.mask(span.name).slice(0, 200),
			kind: span.kind,
			start_time_unix_nano: unixNano(span.startedAt),
			end_time_unix_nano: unixNano(endedAt),
			attributes: { ...span.attributes, ...(this.options.attributes?.() ?? {}) },
			status: span.status,
		};
		const masked = maskSpan(raw, this.options.mask);
		const metadataOnly = withoutPayload(masked);
		for (const exporter of exporters) {
			try {
				exporter.export(exporter.content === true ? masked : metadataOnly);
			} catch (error) {
				this.options.onError?.(error);
			}
		}
	}
}

function newTraceIdFrom(): string {
	let id = `${newSpanId()}${newSpanId()}`;
	while (/^0+$/.test(id)) id = `${newSpanId()}${newSpanId()}`;
	return id;
}
