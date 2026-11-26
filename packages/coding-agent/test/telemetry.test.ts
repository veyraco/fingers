/**
 * Telemetry (F21, open core): GenAI spans of real sessions (model calls with usage and cache tokens, retries, tool
 * calls, one trace per run), masking (credentials never leave, payloads only for an exporter that takes content), the
 * generic OTLP/HTTP JSON exporter and its configuration from the environment, and the built-in extension: nothing at
 * all without an exporter.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fauxAssistantMessage, fauxToolCall } from "@veyraco/fingers-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelemetryExtension } from "../src/core/tracing/extension.ts";
import { OtlpHttpExporter, otlpConfigFromEnv, otlpTraceRequest } from "../src/core/tracing/otlp.ts";
import { TelemetryExporters } from "../src/core/tracing/registry.ts";
import {
	type FingersSpan,
	genAiProviderName,
	maskSpan,
	modelErrorType,
	redactCredentials,
	type SpanExporter,
	unixNano,
	withoutPayload,
} from "../src/core/tracing/spans.ts";
import { SessionTracer } from "../src/core/tracing/tracer.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { createBuiltinTelemetryExtension } from "../src/extensions/telemetry/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
const servers: Server[] = [];
afterEach(async () => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
	vi.unstubAllGlobals();
});

function collector(content = false): SpanExporter & { spans: FingersSpan[] } {
	const spans: FingersSpan[] = [];
	return { content, spans, export: (span) => spans.push(span) };
}

async function tracedSession(exporters: () => readonly SpanExporter[], settings = {}) {
	const harness = await createHarness({
		settings,
		extensionFactories: [{ name: "telemetry", factory: createTelemetryExtension({ exporters }) }],
	});
	harnesses.push(harness);
	return harness;
}

const API_KEY = "sk-ant-api03-Zq9xV2mN8bL4kP7wR1tY6uI3oE5aS0dF";

describe("telemetry spans of a session", () => {
	it("makes one trace per run: invoke_agent, a chat span per model call and an execute_tool span per tool call", async () => {
		const out = collector();
		const harness = await tracedSession(() => [out]);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("ls", {}, { id: "call_ls" })], {
				stopReason: "toolUse",
				responseId: "msg_1",
			}),
			fauxAssistantMessage("Two files.", { responseId: "msg_2" }),
		]);
		await harness.session.prompt("What is here?");

		expect(out.spans.map((span) => span.name)).toEqual([
			"chat faux-1",
			"execute_tool ls",
			"chat faux-1",
			"invoke_agent fingers",
		]);
		const [chat, tool, second, run] = out.spans as [FingersSpan, FingersSpan, FingersSpan, FingersSpan];
		const traceIds = new Set(out.spans.map((span) => span.trace_id));
		expect(traceIds.size).toBe(1);
		expect(run.parent_span_id).toBeUndefined();
		for (const span of [chat, tool, second]) expect(span.parent_span_id).toBe(run.span_id);
		expect(run.attributes).toMatchObject({
			"gen_ai.operation.name": "invoke_agent",
			"gen_ai.agent.name": "fingers",
			"gen_ai.conversation.id": harness.sessionManager.getSessionId(),
		});
		expect(chat).toMatchObject({ kind: "client", status: { code: "ok" } });
		expect(chat.attributes).toMatchObject({
			"gen_ai.operation.name": "chat",
			"gen_ai.provider.name": harness.getModel().provider,
			"gen_ai.request.model": "faux-1",
			"gen_ai.response.id": "msg_1",
			"gen_ai.response.finish_reasons": ["tool_call"],
			"gen_ai.conversation.id": harness.sessionManager.getSessionId(),
		});
		expect(second.attributes["gen_ai.response.finish_reasons"]).toEqual(["stop"]);
		expect(tool.attributes).toMatchObject({
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": "ls",
			"gen_ai.tool.call.id": "call_ls",
			"gen_ai.tool.type": "function",
		});
		for (const span of out.spans) {
			expect(BigInt(span.end_time_unix_nano)).toBeGreaterThanOrEqual(BigInt(span.start_time_unix_nano));
			// Metadata only: no payload for an exporter that does not take content.
			for (const name of Object.keys(span.attributes))
				expect(name).not.toMatch(/messages|instructions|arguments|result/);
		}

		// The next prompt is a new trace.
		harness.setResponses([fauxAssistantMessage("Again.")]);
		await harness.session.prompt("And now?");
		expect(new Set(out.spans.map((span) => span.trace_id)).size).toBe(2);
	});

	it("marks a failed call and the calls made again after it (attempt, reason)", async () => {
		const out = collector();
		const harness = await tracedSession(() => [out], { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } });
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("Go.");
		const chats = out.spans.filter((span) => span.attributes["gen_ai.operation.name"] === "chat");
		expect(chats).toHaveLength(3);
		expect(chats[0]!.status).toEqual({ code: "error" });
		expect(chats[0]!.attributes["error.type"]).toBe("rate_limited");
		expect(chats[0]!.attributes["veyra.retry.attempt"]).toBeUndefined();
		expect(chats[1]!.attributes).toMatchObject({
			"veyra.retry.attempt": 2,
			"veyra.retry.reason": "rate_limited",
			"error.type": "overloaded",
		});
		expect(chats[2]!.attributes).toMatchObject({ "veyra.retry.attempt": 3, "veyra.retry.reason": "overloaded" });
		expect(chats[2]!.status).toEqual({ code: "ok" });
		// One run, one trace, despite the retries.
		expect(out.spans.filter((span) => span.name === "invoke_agent fingers")).toHaveLength(1);
		expect(new Set(out.spans.map((span) => span.trace_id)).size).toBe(1);
		// The provider's error text is a payload: not in a metadata-only span.
		expect(JSON.stringify(out.spans)).not.toContain("rate limit exceeded");
	});

	it("gives payloads only to an exporter that takes content, and never a credential", async () => {
		const metadata = collector(false);
		const content = collector(true);
		const harness = await tracedSession(() => [metadata, content]);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("ls", { path: `.`, note: `key ${API_KEY}` }, { id: "call_1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(`Your key is ${API_KEY}. Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345`),
		]);
		await harness.session.prompt(`Use the key ${API_KEY} and the token ghp_abcdefghijklmnopqrstuvwxyz0123456789`);

		const chat = content.spans.find((span) => span.name.startsWith("chat"))!;
		expect(chat.attributes["gen_ai.input.messages"]).toEqual(expect.any(String));
		const input = JSON.parse(chat.attributes["gen_ai.input.messages"] as string);
		expect(input[0]).toMatchObject({ role: "user", parts: [{ type: "text" }] });
		expect(input[0].parts[0].content).toContain("Use the key [redacted]");
		const tool = content.spans.find((span) => span.name === "execute_tool ls")!;
		expect(tool.attributes["gen_ai.tool.call.arguments"]).toContain('"path":"."');
		expect(tool.attributes["gen_ai.tool.call.result"]).toEqual(expect.any(String));
		const last = content.spans.filter((span) => span.name.startsWith("chat")).at(-1)!;
		const output = JSON.parse(last.attributes["gen_ai.output.messages"] as string);
		expect(output[0].parts[0].content).toBe("Your key is [redacted]. Authorization: Bearer [redacted]");

		const everything = JSON.stringify([...metadata.spans, ...content.spans]);
		expect(everything).not.toContain(API_KEY);
		expect(everything).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
		expect(everything).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
		// The same spans without payloads for the metadata-only exporter.
		expect(metadata.spans.map((span) => span.span_id)).toEqual(content.spans.map((span) => span.span_id));
		expect(JSON.stringify(metadata.spans)).not.toContain("Use the key");
		expect(metadata.spans.every((span) => !("gen_ai.input.messages" in span.attributes))).toBe(true);
	});

	it("makes no span and asks nothing without an exporter", async () => {
		const tracer = vi.fn(() => [] as SpanExporter[]);
		const harness = await tracedSession(tracer);
		harness.setResponses([fauxAssistantMessage([fauxToolCall("ls", {}, { id: "c" })], { stopReason: "toolUse" })]);
		harness.appendResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("hi");
		expect(tracer).toHaveBeenCalled();
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant" });
	});

	it("keeps the session going when an exporter throws", async () => {
		const harness = await tracedSession(() => [
			{
				export: () => {
					throw new Error("boom");
				},
			},
		]);
		harness.setResponses([fauxAssistantMessage("fine")]);
		await harness.session.prompt("hi");
		expect(harness.session.getLastAssistantText()).toBe("fine");
	});

	it("is a built-in extension", () => {
		expect(builtInExtensions.map((entry) => (typeof entry === "function" ? "" : entry.name))).toContain("telemetry");
	});
});

describe("session tracer", () => {
	it("continues a parent trace: a model call's span is the one its request carries, cache tokens counted", () => {
		const out = collector();
		let now = 1_000;
		const tracer = new SessionTracer({
			exporters: () => [out],
			parent: () => ({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba90203", flags: "01" }),
			attributes: () => ({ "veyra.run_id": "run_1" }),
			conversationId: () => "ses_1",
			now: () => now,
		});
		tracer.runStarted();
		const request = tracer.modelRequest()!;
		expect(request.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
		expect(request.parentSpanId).toBe("00f067aa0ba90203");
		now = 3_400;
		tracer.assistantEnded({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "anthropic-messages",
			provider: "amazon-bedrock",
			model: "claude-sonnet-4-5",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 2000,
				cacheWrite: 300,
				totalTokens: 2450,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: now,
		});
		tracer.runSettled(false);
		expect(out.spans).toHaveLength(1);
		expect(out.spans[0]).toEqual({
			trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
			span_id: request.spanId,
			parent_span_id: "00f067aa0ba90203",
			name: "chat claude-sonnet-4-5",
			kind: "client",
			start_time_unix_nano: "1000000000",
			end_time_unix_nano: "3400000000",
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.provider.name": "aws.bedrock",
				"gen_ai.request.model": "claude-sonnet-4-5",
				"gen_ai.response.finish_reasons": ["stop"],
				"gen_ai.usage.input_tokens": 2400,
				"gen_ai.usage.output_tokens": 50,
				"gen_ai.usage.cache_read.input_tokens": 2000,
				"gen_ai.usage.cache_creation.input_tokens": 300,
				"gen_ai.conversation.id": "ses_1",
				"veyra.run_id": "run_1",
			},
			status: { code: "ok" },
		});
	});

	it("records a compaction with the context size before and after", () => {
		const out = collector();
		const tracer = new SessionTracer({ exporters: () => [out], now: () => 5 });
		tracer.runStarted();
		tracer.compacted(180_000.4, 21_000);
		expect(out.spans[0]).toMatchObject({
			name: "veyra.compaction",
			attributes: { "veyra.compaction.tokens_before": 180_000, "veyra.compaction.tokens_after": 21_000 },
		});
	});
});

describe("span helpers", () => {
	it("maps provider ids to the GenAI conventions' names", () => {
		expect(genAiProviderName("anthropic")).toBe("anthropic");
		expect(genAiProviderName("google")).toBe("gcp.gemini");
		expect(genAiProviderName("google-vertex")).toBe("gcp.vertex_ai");
		expect(genAiProviderName("xai")).toBe("x_ai");
		expect(genAiProviderName("openrouter")).toBe("openrouter");
	});

	it("names model errors without their text", () => {
		expect(modelErrorType("HTTP 429 Too Many Requests")).toBe("rate_limited");
		expect(modelErrorType("overloaded_error")).toBe("overloaded");
		expect(modelErrorType("request timed out")).toBe("timeout");
		expect(modelErrorType("401 invalid x-api-key")).toBe("credentials");
		expect(modelErrorType("something else")).toBe("provider_error");
	});

	it("masks credentials by name and by shape, and the caller's secrets, without touching ordinary text", () => {
		const span: FingersSpan = {
			trace_id: "a".repeat(32),
			span_id: "b".repeat(16),
			name: "chat x",
			kind: "client",
			start_time_unix_nano: unixNano(1),
			end_time_unix_nano: unixNano(2),
			attributes: {
				"http.request.header.authorization": "Bearer abc",
				"gen_ai.request.model": "gpt-5",
				"gen_ai.usage.input_tokens": 12,
				"x.api_key": "whatever",
				"gen_ai.input.messages": `token hpt_run_secret_value and ${API_KEY} and AKIAABCDEFGHIJKLMNOP`,
				list: ["sk-proj-abcdefghijklmnopqrstuvwxyz", "plain"],
			},
			status: { code: "error", message: "bad key hpt_run_secret_value" },
		};
		const masked = maskSpan(span, { redactSecrets: (text) => text.split("hpt_run_secret_value").join("[redacted]") });
		expect(masked.attributes).toEqual({
			"gen_ai.request.model": "gpt-5",
			"gen_ai.usage.input_tokens": 12,
			"gen_ai.input.messages": "token [redacted] and [redacted] and [redacted]",
			list: ["[redacted]", "plain"],
		});
		expect(masked.status).toEqual({ code: "error", message: "bad key [redacted]" });
		expect(redactCredentials("version 2023-06-01, x-flag true")).toBe("version 2023-06-01, x-flag true");
		expect(withoutPayload(masked).attributes).not.toHaveProperty("gen_ai.input.messages");
		expect(withoutPayload(masked).status).toEqual({ code: "error" });
	});
});

describe("OTLP exporter", () => {
	function listen(handler: (request: IncomingMessage, body: string) => number) {
		const received: Array<{ headers: IncomingMessage["headers"]; body: any; url: string }> = [];
		const server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				received.push({ headers: request.headers, body: JSON.parse(body), url: request.url ?? "" });
				response.statusCode = handler(request, body);
				response.end("{}");
			});
		});
		servers.push(server);
		return new Promise<{ url: string; received: typeof received }>((resolve) =>
			server.listen(0, "127.0.0.1", () =>
				resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received }),
			),
		);
	}

	const span = (id: string, attributes: FingersSpan["attributes"] = {}): FingersSpan => ({
		trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
		span_id: id,
		parent_span_id: "00f067aa0ba90203",
		name: "chat m",
		kind: "client",
		start_time_unix_nano: "1795701792000000000",
		end_time_unix_nano: "1795701795400000000",
		attributes,
		status: { code: "ok" },
	});

	it("encodes OTLP/JSON (hex ids, decimal times, typed values)", () => {
		const body = otlpTraceRequest(
			[span("a1b2c3d4e5f60718", { "gen_ai.usage.input_tokens": 2400, ratio: 0.5, ok: true, list: ["a", "b"] })],
			{ "service.name": "fingers" },
			{ name: "fingers", version: "0.1.0" },
		) as any;
		const [out] = body.resourceSpans[0].scopeSpans[0].spans;
		expect(body.resourceSpans[0].resource.attributes).toEqual([
			{ key: "service.name", value: { stringValue: "fingers" } },
		]);
		expect(out).toMatchObject({
			traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
			spanId: "a1b2c3d4e5f60718",
			parentSpanId: "00f067aa0ba90203",
			kind: 3,
			startTimeUnixNano: "1795701792000000000",
			status: { code: 1 },
		});
		expect(out.attributes).toEqual([
			{ key: "gen_ai.usage.input_tokens", value: { intValue: "2400" } },
			{ key: "ratio", value: { doubleValue: 0.5 } },
			{ key: "ok", value: { boolValue: true } },
			{ key: "list", value: { arrayValue: { values: [{ stringValue: "a" }, { stringValue: "b" }] } } },
		]);
	});

	it("batches spans, sends them with fresh headers on flush and drops a batch it may no longer send", async () => {
		const server = await listen(() => 200);
		let token = "t1";
		let allowed = true;
		const errors: unknown[] = [];
		const exporter = new OtlpHttpExporter({
			url: `${server.url}/v1/traces`,
			headers: () => ({ authorization: `Bearer ${token}` }),
			version: "9.9.9",
			allowSend: () => allowed,
			maxBatch: 2,
			flushIntervalMs: 60_000,
			onError: (error) => errors.push(error),
		});
		exporter.export(span("0000000000000001"));
		// A full batch goes out at once.
		exporter.export(span("0000000000000002"));
		await exporter.flush();
		token = "t2";
		exporter.export(span("0000000000000003"));
		await exporter.flush();
		expect(server.received.map((r) => r.body.resourceSpans[0].scopeSpans[0].spans.length)).toEqual([2, 1]);
		expect(server.received.map((r) => r.headers.authorization)).toEqual(["Bearer t1", "Bearer t2"]);
		expect(server.received[0]!.url).toBe("/v1/traces");
		expect(server.received[0]!.headers["content-type"]).toBe("application/json");
		expect(server.received[0]!.body.resourceSpans[0].resource.attributes).toEqual(
			expect.arrayContaining([
				{ key: "service.name", value: { stringValue: "fingers" } },
				{ key: "service.version", value: { stringValue: "9.9.9" } },
			]),
		);
		allowed = false;
		exporter.export(span("0000000000000004"));
		await exporter.flush();
		expect(server.received).toHaveLength(2);
		expect(String(errors[0])).toContain("dropped");
	});

	it("never throws on a refused or unreachable destination", async () => {
		const server = await listen(() => 503);
		const errors: unknown[] = [];
		const refused = new OtlpHttpExporter({ url: `${server.url}/v1/traces`, onError: (e) => errors.push(e) });
		refused.export(span("0000000000000001"));
		await refused.flush();
		const down = new OtlpHttpExporter({ url: "http://127.0.0.1:9/v1/traces", onError: (e) => errors.push(e) });
		down.export(span("0000000000000002"));
		await down.flush();
		expect(errors).toHaveLength(2);
		expect(String(errors[0])).toContain("HTTP 503");
	});

	it("reads its destination from the environment", () => {
		expect(otlpConfigFromEnv({})).toBeUndefined();
		expect(
			otlpConfigFromEnv({
				FINGERS_OTLP_ENDPOINT: "https://otel.example.com:4318/",
				FINGERS_OTLP_HEADERS: "authorization=Bearer%20abc,x-team = web",
				FINGERS_OTLP_CAPTURE_CONTENT: "true",
			}),
		).toEqual({
			url: "https://otel.example.com:4318/v1/traces",
			headers: { authorization: "Bearer abc", "x-team": "web" },
			content: true,
		});
		expect(otlpConfigFromEnv({ FINGERS_OTLP_TRACES_ENDPOINT: "http://localhost:4318/custom" })).toEqual({
			url: "http://localhost:4318/custom",
			headers: {},
			content: false,
		});
		expect(() => otlpConfigFromEnv({ FINGERS_OTLP_ENDPOINT: "ftp://x" })).toThrow(/http/);
	});

	it("the built-in extension sends each run's trace to the person's OTLP destination, and nothing without one", async () => {
		const server = await listen(() => 200);
		const fetched: string[] = [];
		const realFetch = globalThis.fetch;
		vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			fetched.push(String(input instanceof Request ? input.url : input));
			return realFetch(input, init);
		});

		// Without FINGERS_OTLP_*: no span, no request.
		const none = new TelemetryExporters();
		const quiet = await createHarness({
			extensionFactories: [{ name: "telemetry", factory: createBuiltinTelemetryExtension(none, {}) }],
		});
		harnesses.push(quiet);
		quiet.setResponses([fauxAssistantMessage("ok")]);
		await quiet.session.prompt("hi");
		expect(none.active()).toEqual([]);
		expect(fetched).toEqual([]);

		const exporters = new TelemetryExporters();
		const harness = await createHarness({
			extensionFactories: [
				{
					name: "telemetry",
					factory: createBuiltinTelemetryExtension(exporters, {
						FINGERS_OTLP_ENDPOINT: server.url,
						FINGERS_OTLP_HEADERS: "authorization=Bearer otlp_header_secret_123",
					}),
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Answer that quotes otlp_header_secret_123.")]);
		await harness.session.prompt("hi");
		await vi.waitFor(() => expect(server.received).toHaveLength(1), { timeout: 5_000 });
		const sent = server.received[0]!;
		expect(sent.url).toBe("/v1/traces");
		expect(sent.headers.authorization).toBe("Bearer otlp_header_secret_123");
		const names = sent.body.resourceSpans[0].scopeSpans[0].spans.map((s: any) => s.name);
		expect(names).toEqual(["chat faux-1", "invoke_agent fingers"]);
		expect(JSON.stringify(sent.body)).not.toContain("Answer that quotes");
		expect(fetched.every((url) => url.startsWith(server.url))).toBe(true);
	});
});
