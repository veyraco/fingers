/**
 * Conformance of the first-version Fingers providers (the list on the first-run screen): each provider's
 * real request path (SDK, auth, endpoint) is replayed against a wire fixture of its protocol, and the
 * result must carry streamed thinking, text, a parsed tool call, the tool-use stop reason, and usage
 * with prompt-cache tokens and list-price cost.
 */

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EventStreamCodec } from "@smithy/core/event-streams";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { streamSimple as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { setVertexTokenSource, type VertexTokenSource } from "../src/api/vertex-token.ts";
import { calculateCost, type Provider } from "../src/models.ts";
import { builtinProviders } from "../src/providers/all.ts";
import type { Api, AssistantMessage, FetchFunction, Model, ProviderEnv, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import {
	anthropicMessagesSse,
	bedrockConverseEvents,
	CACHE_READ_TOKENS,
	CACHE_WRITE_TOKENS,
	type CompletionsReasoningField,
	geminiSse,
	INPUT_TOKENS,
	OUTPUT_TOKENS,
	openAICompletionsSse,
	openAIResponsesSse,
	TEXT,
	THINKING,
	TOOL_ARGS,
	TOOL_NAME,
} from "./fixtures/provider-conformance.ts";

const readFileTool: Tool = {
	name: TOOL_NAME,
	description: "Read a file from the workspace",
	parameters: Type.Object({ path: Type.String() }),
};

const context = normalizeContext({
	systemPrompt: "You are Fingers, a coding agent.",
	messages: [{ role: "user", content: "Open src/app.ts", timestamp: 1 }],
	tools: [readFileTool],
});

interface RecordedRequest {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
}

function fixtureFetch(responseBody: string, requests: RecordedRequest[]): FetchFunction {
	return async (input, init) => {
		const request = input instanceof Request ? input : undefined;
		const url = request ? request.url : typeof input === "string" ? input : (input as URL).href;
		const headers = new Headers(request ? request.headers : init?.headers);
		const rawBody = request ? await request.text() : typeof init?.body === "string" ? init.body : "";
		requests.push({ url, headers, body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {} });
		return new Response(responseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
}

function provider(id: string): Provider {
	const found = builtinProviders().find((entry) => entry.id === id);
	if (!found) throw new Error(`no built-in provider ${id}`);
	return found;
}

function reasoningModel(providerId: string, prefer?: (model: Model<Api>) => boolean): Model<Api> {
	const models = provider(providerId).getModels();
	const model =
		models.find((entry) => entry.reasoning && (!prefer || prefer(entry))) ?? models.find((entry) => entry.reasoning);
	if (!model) throw new Error(`${providerId} has no reasoning model`);
	return model;
}

interface Expected {
	cacheWrite: number;
}

function expectConformingTurn(message: AssistantMessage, model: Model<Api>, expected: Expected): void {
	expect(message.errorMessage).toBeUndefined();
	expect(message.stopReason).toBe("toolUse");
	const thinking = message.content.find((block) => block.type === "thinking");
	expect(thinking?.type === "thinking" && thinking.thinking.trim()).toBe(THINKING);
	const text = message.content.find((block) => block.type === "text");
	expect(text?.type === "text" && text.text).toBe(TEXT);
	const call = message.content.find((block) => block.type === "toolCall");
	expect(call?.type === "toolCall" && call.name).toBe(TOOL_NAME);
	expect(call?.type === "toolCall" && call.arguments).toEqual(TOOL_ARGS);
	expect(message.usage.input).toBe(INPUT_TOKENS);
	expect(message.usage.cacheRead).toBe(CACHE_READ_TOKENS);
	expect(message.usage.cacheWrite).toBe(expected.cacheWrite);
	expect(message.usage.output).toBe(OUTPUT_TOKENS);
	const cost = calculateCost(model, { ...message.usage });
	expect(message.usage.cost.total).toBeCloseTo(cost.total, 10);
	if (model.cost.input > 0) expect(message.usage.cost.total).toBeGreaterThan(0);
}

async function run(
	providerId: string,
	model: Model<Api>,
	options: { apiKey?: string; env?: ProviderEnv; fetch?: FetchFunction },
): Promise<AssistantMessage> {
	return provider(providerId)
		.streamSimple(model, context, { ...options, reasoning: "medium", maxRetries: 0 })
		.result();
}

describe("first-version providers replay their wire protocol", () => {
	const API_KEY = "conformance-key-123";

	it("Anthropic API: Messages SSE with x-api-key, thinking, cache writes", async () => {
		const requests: RecordedRequest[] = [];
		const model = reasoningModel("anthropic", (entry) => entry.id.startsWith("claude-sonnet"));
		const message = await run("anthropic", model, {
			apiKey: API_KEY,
			fetch: fixtureFetch(anthropicMessagesSse(model.id), requests),
		});
		expectConformingTurn(message, model, { cacheWrite: CACHE_WRITE_TOKENS });
		expect(requests[0].url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/);
		expect(requests[0].headers.get("x-api-key")).toBe(API_KEY);
		expect(requests[0].body.model).toBe(model.id);
		expect((requests[0].body.tools as Array<{ name: string }>)[0].name).toBe(TOOL_NAME);
		expect(requests[0].body.thinking).toBeDefined();
		expect(JSON.stringify(requests[0].body)).toContain("cache_control");
	});

	describe("Google Vertex AI (Claude)", () => {
		let previous: VertexTokenSource;
		beforeAll(() => {
			previous = setVertexTokenSource(async () => "ya29.conformance-token");
		});
		afterAll(() => {
			setVertexTokenSource(previous);
		});

		it("sends Anthropic Messages to streamRawPredict with a Google token", async () => {
			const requests: RecordedRequest[] = [];
			const model = reasoningModel("google-vertex-anthropic", (entry) => entry.id === "claude-sonnet-4-5-20250929");
			const message = await run("google-vertex-anthropic", model, {
				env: { GOOGLE_CLOUD_PROJECT: "veyra-test", GOOGLE_CLOUD_LOCATION: "us-east5" },
				fetch: fixtureFetch(anthropicMessagesSse(model.id), requests),
			});
			expectConformingTurn(message, model, { cacheWrite: CACHE_WRITE_TOKENS });
			const vertexId = model.id.replace(/-(\d{8})$/, "@$1");
			expect(requests[0].url).toBe(
				`https://us-east5-aiplatform.googleapis.com/v1/projects/veyra-test/locations/us-east5/publishers/anthropic/models/${encodeURIComponent(vertexId)}:streamRawPredict`,
			);
			expect(requests[0].headers.get("authorization")).toBe("Bearer ya29.conformance-token");
			expect(requests[0].headers.get("x-api-key")).toBeNull();
			expect(requests[0].body.anthropic_version).toBe("vertex-2023-10-16");
			expect(requests[0].body.model).toBeUndefined();
			expect(requests[0].body.stream).toBe(true);
			expect((requests[0].body.tools as Array<{ name: string }>)[0].name).toBe(TOOL_NAME);
		});

		it("uses the global endpoint when no location is set and fails clearly without a project", async () => {
			const requests: RecordedRequest[] = [];
			const model = reasoningModel("google-vertex-anthropic");
			await run("google-vertex-anthropic", model, {
				env: { GOOGLE_CLOUD_PROJECT: "veyra-test" },
				fetch: fixtureFetch(anthropicMessagesSse(model.id), requests),
			});
			expect(requests[0].url).toMatch(
				/^https:\/\/aiplatform\.googleapis\.com\/v1\/projects\/veyra-test\/locations\/global\/publishers\/anthropic\/models\//,
			);
			const failed = await run("google-vertex-anthropic", model, { env: {}, fetch: fixtureFetch("", []) });
			expect(failed.stopReason).toBe("error");
			expect(failed.errorMessage).toMatch(/GOOGLE_CLOUD_PROJECT/);
		});
	});

	it("OpenAI: Responses SSE with reasoning summary and cached input", async () => {
		const requests: RecordedRequest[] = [];
		const model = reasoningModel("openai");
		const message = await run("openai", model, {
			apiKey: API_KEY,
			fetch: fixtureFetch(openAIResponsesSse(model.id), requests),
		});
		expectConformingTurn(message, model, { cacheWrite: 0 });
		expect(requests[0].url).toBe("https://api.openai.com/v1/responses");
		expect(requests[0].headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
		expect((requests[0].body.tools as Array<{ name: string }>)[0].name).toBe(TOOL_NAME);
		expect(requests[0].body.reasoning).toBeDefined();
	});

	it("xAI Grok: Responses SSE at api.x.ai", async () => {
		const requests: RecordedRequest[] = [];
		const model = reasoningModel("xai");
		const message = await run("xai", model, {
			apiKey: API_KEY,
			fetch: fixtureFetch(openAIResponsesSse(model.id), requests),
		});
		expectConformingTurn(message, model, { cacheWrite: 0 });
		expect(requests[0].url).toBe("https://api.x.ai/v1/responses");
		expect(requests[0].headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
	});

	it("Google Gemini: streamGenerateContent SSE with thoughts and cached content", async () => {
		const requests: RecordedRequest[] = [];
		const model = reasoningModel("google", (entry) => entry.id.startsWith("gemini-"));
		const message = await run("google", model, { apiKey: API_KEY, fetch: fixtureFetch(geminiSse(), requests) });
		expectConformingTurn(message, model, { cacheWrite: 0 });
		expect(requests[0].url).toContain(
			`generativelanguage.googleapis.com/v1beta/models/${model.id}:streamGenerateContent`,
		);
		expect(requests[0].headers.get("x-goog-api-key")).toBe(API_KEY);
		const tools = requests[0].body.tools as Array<{ functionDeclarations: Array<{ name: string }> }>;
		expect(tools[0].functionDeclarations[0].name).toBe(TOOL_NAME);
		expect((requests[0].body.generationConfig as { thinkingConfig?: unknown }).thinkingConfig).toBeDefined();
	});

	const completionsCases: Array<{
		label: string;
		providerId: string;
		url: string;
		reasoningField: CompletionsReasoningField;
		usage: "openai" | "deepseek";
	}> = [
		{
			label: "OpenRouter",
			providerId: "openrouter",
			url: "https://openrouter.ai/api/v1/chat/completions",
			reasoningField: "reasoning",
			usage: "openai",
		},
		{
			label: "Moonshot Kimi",
			providerId: "moonshotai",
			url: "https://api.moonshot.ai/v1/chat/completions",
			reasoningField: "reasoning_content",
			usage: "openai",
		},
		{
			label: "DeepSeek",
			providerId: "deepseek",
			url: "https://api.deepseek.com/chat/completions",
			reasoningField: "reasoning_content",
			usage: "deepseek",
		},
		{
			label: "Qwen",
			providerId: "qwen",
			url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
			reasoningField: "reasoning_content",
			usage: "openai",
		},
	];

	for (const testCase of completionsCases) {
		it(`${testCase.label}: Chat Completions SSE with ${testCase.reasoningField} and cached prompt tokens`, async () => {
			const requests: RecordedRequest[] = [];
			const model = reasoningModel(testCase.providerId, (entry) => entry.api === "openai-completions");
			expect(model.api).toBe("openai-completions");
			const message = await run(testCase.providerId, model, {
				apiKey: API_KEY,
				fetch: fixtureFetch(openAICompletionsSse(model.id, testCase), requests),
			});
			expectConformingTurn(message, model, { cacheWrite: 0 });
			expect(requests[0].url).toBe(testCase.url);
			expect(requests[0].headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
			expect(requests[0].body.stream).toBe(true);
			const tools = requests[0].body.tools as Array<{ function: { name: string } }>;
			expect(tools[0].function.name).toBe(TOOL_NAME);
		});
	}

	it("Any OpenAI-compatible endpoint: a models.json-style model on its own base URL", async () => {
		const requests: RecordedRequest[] = [];
		const model: Model<"openai-completions"> = {
			id: "local-coder",
			name: "Local coder",
			api: "openai-completions",
			provider: "my-endpoint",
			baseUrl: "https://llm.internal.example/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8192,
		};
		const message = await streamOpenAICompletions(model, context, {
			apiKey: API_KEY,
			reasoning: "medium",
			fetch: fixtureFetch(
				openAICompletionsSse(model.id, { reasoningField: "reasoning_content", usage: "openai" }),
				requests,
			),
		}).result();
		expectConformingTurn(message, model, { cacheWrite: 0 });
		expect(requests[0].url).toBe("https://llm.internal.example/v1/chat/completions");
		expect(requests[0].headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
	});

	describe("Amazon Bedrock: ConverseStream over the binary AWS event stream", () => {
		let server: Server;
		let baseUrl: string;
		const received: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders; body: string }> = [];
		const codec = new EventStreamCodec(
			(bytes) => new TextDecoder().decode(bytes),
			(text) => new TextEncoder().encode(text),
		);

		beforeAll(async () => {
			server = createServer((request, response) => {
				let body = "";
				request.on("data", (chunk) => {
					body += chunk;
				});
				request.on("end", () => {
					received.push({ method: request.method, url: request.url, headers: request.headers, body });
					response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
					for (const event of bedrockConverseEvents()) {
						response.write(
							codec.encode({
								headers: {
									":event-type": { type: "string", value: event.type },
									":content-type": { type: "string", value: "application/json" },
									":message-type": { type: "string", value: "event" },
								},
								body: new TextEncoder().encode(JSON.stringify(event.body)),
							}),
						);
					}
					response.end();
				});
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		});

		afterAll(async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});

		afterEach(() => {
			received.length = 0;
		});

		it("signs with SigV4 and maps reasoning, tool use and cache usage", async () => {
			const catalogModel = reasoningModel("amazon-bedrock", (entry) => entry.id.includes("anthropic.claude"));
			const model = { ...catalogModel, baseUrl };
			const message = await run("amazon-bedrock", model, {
				env: {
					AWS_ACCESS_KEY_ID: "AKIDCONFORMANCE",
					AWS_SECRET_ACCESS_KEY: "conformance-secret",
					AWS_BEDROCK_FORCE_HTTP1: "1",
				},
			});
			expectConformingTurn(message, model, { cacheWrite: CACHE_WRITE_TOKENS });
			expect(received[0].method).toBe("POST");
			expect(received[0].url).toBe(`/model/${encodeURIComponent(model.id)}/converse-stream`);
			expect(received[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDCONFORMANCE\//);
			const body = JSON.parse(received[0].body) as { toolConfig: { tools: Array<{ toolSpec: { name: string } }> } };
			expect(body.toolConfig.tools[0].toolSpec.name).toBe(TOOL_NAME);
			expect(received[0].body).not.toContain("conformance-secret");
		});
	});
});

describe("first-version provider list", () => {
	it("every provider on the first-run screen is built in", () => {
		const ids = new Set(builtinProviders().map((entry) => entry.id));
		for (const id of [
			"anthropic",
			"amazon-bedrock",
			"google-vertex-anthropic",
			"google-vertex",
			"openai",
			"google",
			"openrouter",
			"moonshotai",
			"xai",
			"deepseek",
			"qwen",
		]) {
			expect(ids.has(id), id).toBe(true);
		}
	});

	it("Claude on Vertex lists Anthropic's Claude models with Anthropic's list prices", () => {
		const vertex = provider("google-vertex-anthropic").getModels();
		const anthropic = new Map(
			provider("anthropic")
				.getModels()
				.map((model) => [model.id, model]),
		);
		expect(vertex.length).toBeGreaterThan(5);
		for (const model of vertex) {
			expect(model.api).toBe("anthropic-messages");
			expect(anthropic.get(model.id)?.cost.input, model.id).toBe(model.cost.input);
			expect(anthropic.get(model.id)?.cost.output, model.id).toBe(model.cost.output);
		}
	});

	it("Qwen lists Model Studio's Qwen text models with prices", () => {
		const qwen = provider("qwen").getModels();
		expect(qwen.length).toBeGreaterThan(3);
		for (const model of qwen) {
			expect(model.id.startsWith("qwen")).toBe(true);
			expect(model.baseUrl).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
			expect(model.cost.input).toBeGreaterThan(0);
		}
	});
});
