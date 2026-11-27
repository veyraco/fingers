/**
 * The telemetry extension (open core): traces the sessions of the terminal app, print and JSON modes with the
 * session tracer and hands the spans to the live exporters (the person's own OTLP destination, Eyes while the ee
 * feature is on). Without an exporter it makes no span at all. Each run is one trace; spans go out when the run ends
 * and when the session shuts down. Managed RPC does not use it: there the server relays spans to the host.
 */
import type { AgentMessage } from "@veyraco/fingers-agent";
import type { AssistantMessage } from "@veyraco/fingers-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../extensions/types.ts";
import type { MaskOptions, SpanExporter } from "./spans.ts";
import { SessionTracer } from "./tracer.ts";

interface TelemetryExtensionOptions {
	/** The exporters that take spans right now. */
	exporters(): readonly SpanExporter[];
	/** Send what the exporters have queued. */
	flush?(): Promise<void>;
	mask?: MaskOptions;
	/** How long the session's shutdown waits for the last spans to go out. Default 2 s. */
	shutdownFlushMs?: number;
	onError?(error: unknown): void;
	now?(): number;
}

function transcript(ctx: ExtensionContext | undefined): AgentMessage[] {
	if (!ctx) return [];
	return ctx.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "message")
		.map((entry) => (entry as { message: AgentMessage }).message);
}

export function createTelemetryExtension(options: TelemetryExtensionOptions): ExtensionFactory {
	return (fingers: ExtensionAPI) => {
		let ctx: ExtensionContext | undefined;
		const tracer = new SessionTracer({
			exporters: () => options.exporters(),
			conversationId: () => ctx?.sessionManager.getSessionId(),
			systemPrompt: () => ctx?.getSystemPrompt(),
			messages: () => transcript(ctx),
			mask: options.mask,
			onError: options.onError,
			now: options.now,
		});
		const flush = () => options.flush?.().catch((error) => options.onError?.(error));

		fingers.on("agent_start", (_event, context) => {
			ctx = context;
			tracer.runStarted();
		});
		fingers.on("message_start", (event, context) => {
			ctx = context;
			if (event.message.role === "assistant") tracer.assistantStarted();
		});
		fingers.on("message_end", (event, context) => {
			ctx = context;
			if (event.message.role === "assistant") tracer.assistantEnded(event.message as AssistantMessage);
		});
		fingers.on("tool_execution_start", (event, context) => {
			ctx = context;
			tracer.toolStarted(event.toolCallId, event.toolName, event.args);
		});
		fingers.on("tool_execution_end", (event, context) => {
			ctx = context;
			tracer.toolEnded(event.toolCallId, event.toolName, event.result, event.isError);
		});
		fingers.on("session_compact", (event, context) => {
			ctx = context;
			const after = context.getContextUsage()?.tokens;
			tracer.compacted(event.compactionEntry.tokensBefore, typeof after === "number" ? after : undefined);
		});
		fingers.on("agent_settled", (event, context) => {
			ctx = context;
			tracer.runSettled(event.aborted);
			// The run's trace goes out now rather than at the next timer.
			void flush();
		});
		fingers.on("session_shutdown", async () => {
			tracer.runSettled(true);
			const timeout = options.shutdownFlushMs ?? 2_000;
			await Promise.race([flush(), new Promise((resolve) => setTimeout(resolve, timeout).unref?.())]);
		});
	};
}
