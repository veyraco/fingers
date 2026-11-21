/**
 * W3C Trace Context for managed RPC: every command carries a `traceparent`; the work it starts continues
 * that trace with a new span id, and log lines carry the ids (contracts/v1/logging.md).
 */
import { randomBytes } from "node:crypto";

export interface TraceContext {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	flags: string;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function parseTraceparent(value: unknown): { traceId: string; parentId: string; flags: string } | undefined {
	if (typeof value !== "string") return undefined;
	const match = TRACEPARENT.exec(value.trim());
	if (!match) return undefined;
	const [, traceId, parentId, flags] = match;
	if (/^0+$/.test(traceId!) || /^0+$/.test(parentId!)) return undefined;
	return { traceId: traceId!, parentId: parentId!, flags: flags! };
}

export function newSpanId(): string {
	let id = randomBytes(8).toString("hex");
	while (/^0+$/.test(id)) id = randomBytes(8).toString("hex");
	return id;
}

function newTraceId(): string {
	let id = randomBytes(16).toString("hex");
	while (/^0+$/.test(id)) id = randomBytes(16).toString("hex");
	return id;
}

/** Continue a valid incoming trace with a new span, or start a new trace. */
export function continueTrace(traceparent: unknown): { context: TraceContext; valid: boolean } {
	const parsed = parseTraceparent(traceparent);
	if (!parsed) return { context: { traceId: newTraceId(), spanId: newSpanId(), flags: "01" }, valid: false };
	return {
		context: { traceId: parsed.traceId, spanId: newSpanId(), parentSpanId: parsed.parentId, flags: parsed.flags },
		valid: true,
	};
}

export function formatTraceparent(context: TraceContext): string {
	return `00-${context.traceId}-${context.spanId}-${context.flags}`;
}

/**
 * A new child span of `parent` for one outgoing call (a model request): same trace id and flags, a new span
 * id, and the parent's span as its parent.
 */
export function childSpan(parent: TraceContext): TraceContext {
	return { traceId: parent.traceId, spanId: newSpanId(), parentSpanId: parent.spanId, flags: parent.flags };
}
