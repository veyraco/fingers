/**
 * Prompt caching across turns, per first-version provider. Each provider's real request path is driven
 * through three agent turns (prompt -> tool call -> tool result -> tool call -> tool result + new prompt)
 * against its wire fixture, and every request body is recorded. The tests check:
 *
 * - the cache markers each provider needs are in the request (Anthropic `cache_control` on the system
 *   prompt, the last tool, the last message and the previous turn's last message; Bedrock `cachePoint`;
 *   OpenAI `prompt_cache_key`; Gemini context caching; nothing for DeepSeek, whose caching is automatic);
 * - the cached prefix stays byte-identical from one turn to the next once the markers are removed, so a
 *   provider's prefix cache can match it;
 * - cache reads and writes reach the usage.
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EventStreamCodec } from "@smithy/core/event-streams";
import { Type } from "typebox";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetGeminiContextCaches } from "../src/api/google-context-cache.ts";
import type { Provider } from "../src/models.ts";
import { builtinProviders } from "../src/providers/all.ts";
import type {
	Api,
	AssistantMessage,
	FetchFunction,
	Message,
	Model,
	ProviderEnv,
	SimpleStreamOptions,
	Tool,
	ToolResultMessage,
} from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import {
	anthropicMessagesSse,
	bedrockConverseEvents,
	CACHE_READ_TOKENS,
	CACHE_WRITE_TOKENS,
	geminiSse,
	openAICompletionsSse,
	openAIResponsesSse,
	TOOL_NAME,
} from "./fixtures/provider-conformance.ts";

type Rec = Record<string, any>;

const API_KEY = "cache-test-key-123";
const SESSION_ID = "fingers-session-cache-0001";
const SYSTEM_PROMPT = `You are Fingers, a coding agent.\n${"Follow the repository conventions. ".repeat(400)}`;

const readFileTool: Tool = {
	name: TOOL_NAME,
	description: "Read a file from the workspace",
	parameters: Type.Object({ path: Type.String() }),
};
const writeFileTool: Tool = {
	name: "write_file",
	description: "Write a file in the workspace",
	parameters: Type.Object({ path: Type.String(), content: Type.String() }),
};

function provider(id: string): Provider {
	const found = builtinProviders().find((entry) => entry.id === id);
	if (!found) throw new Error(`no built-in provider ${id}`);
	return found;
}

function pickModel(providerId: string, prefer: (model: Model<Api>) => boolean): Model<Api> {
	const model = provider(providerId)
		.getModels()
		.find((entry) => entry.reasoning && prefer(entry));
	if (!model) throw new Error(`${providerId} has no matching model`);
	return model;
}

interface Recorded {
	url: string;
	headers: Headers;
	body: Rec;
}

/** A fetch that answers each streaming request with the turn's fixture and records every request. */
function turnFetch(
	turnResponse: (turn: number) => string,
	requests: Recorded[],
	extra?: (url: string, body: Rec) => Response | undefined,
): FetchFunction {
	let turn = 0;
	return async (input, init) => {
		const request = input instanceof Request ? input : undefined;
		const url = request ? request.url : typeof input === "string" ? input : (input as URL).href;
		const headers = new Headers(request ? request.headers : init?.headers);
		const rawBody = request ? await request.text() : typeof init?.body === "string" ? init.body : "";
		const body = rawBody ? (JSON.parse(rawBody) as Rec) : {};
		requests.push({ url, headers, body });
		const answered = extra?.(url, body);
		if (answered) return answered;
		turn++;
		return new Response(turnResponse(turn), { status: 200, headers: { "content-type": "text/event-stream" } });
	};
}

/** Give each turn's tool call its own id, as a real provider would. */
function withTurnIds(fixture: string, turn: number, ids: string[]): string {
	return ids.reduce((text, id) => text.replaceAll(id, `${id}_t${turn}`), fixture);
}

function toolResult(message: AssistantMessage, text: string): ToolResultMessage {
	const call = message.content.find((block) => block.type === "toolCall");
	if (!call || call.type !== "toolCall")
		throw new Error(`no tool call: ${message.errorMessage ?? message.stopReason}`);
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	};
}

/**
 * Three agent turns: the prompt, the first tool result, then the second tool result followed by a new prompt.
 * Returns the assistant messages; the caller's fetch records the requests.
 */
async function runThreeTurns(
	providerId: string,
	model: Model<Api>,
	options: { apiKey?: string; env?: ProviderEnv; fetch?: FetchFunction; cacheRetention?: "short" | "long" },
): Promise<AssistantMessage[]> {
	const messages: Message[] = [{ role: "user", content: "Open src/app.ts", timestamp: 1 }];
	const replies: AssistantMessage[] = [];
	const streamOptions: SimpleStreamOptions = {
		...options,
		sessionId: SESSION_ID,
		reasoning: "medium",
		maxRetries: 0,
	};
	for (let turn = 1; turn <= 3; turn++) {
		const context = normalizeContext({ systemPrompt: SYSTEM_PROMPT, messages, tools: [readFileTool, writeFileTool] });
		const reply = await provider(providerId).streamSimple(model, context, streamOptions).result();
		expect(reply.errorMessage, `${providerId} turn ${turn}`).toBeUndefined();
		replies.push(reply);
		messages.push(reply, toolResult(reply, `export const app = ${turn};`));
		if (turn === 2) messages.push({ role: "user", content: "Now add a test for it.", timestamp: 3 });
	}
	return replies;
}

/** Remove cache markers (and the blocks that only hold one) so prefixes can be compared byte for byte. */
function stripMarkers(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value
			.filter((item) => !(item && typeof item === "object" && Object.keys(item).join() === "cachePoint"))
			.map(stripMarkers);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key !== "cache_control")
				.map(([key, nested]) => [key, stripMarkers(nested)]),
		);
	}
	return value;
}

/** Each request's message list, markers removed, must start with the previous request's whole list. */
function expectAppendOnly(lists: unknown[][]): void {
	for (let i = 1; i < lists.length; i++) {
		const previous = lists[i - 1].map((item) => JSON.stringify(stripMarkers(item)));
		const current = lists[i].map((item) => JSON.stringify(stripMarkers(item)));
		expect(current.length).toBeGreaterThan(previous.length);
		expect(current.slice(0, previous.length), `request ${i + 1} keeps request ${i}'s prefix`).toEqual(previous);
	}
}

function expectSameBytes(values: unknown[], label: string): void {
	const first = JSON.stringify(values[0]);
	expect(first, label).toBeDefined();
	for (const value of values.slice(1)) expect(JSON.stringify(value), label).toBe(first);
}

/** Paths of every `cache_control` marker in a request body. */
function markerPaths(value: unknown, path = ""): string[] {
	if (Array.isArray(value)) return value.flatMap((item, index) => markerPaths(item, `${path}[${index}]`));
	if (value && typeof value === "object") {
		return Object.entries(value).flatMap(([key, nested]) =>
			key === "cache_control" || key === "cachePoint" ? [path] : markerPaths(nested, `${path}.${key}`),
		);
	}
	return [];
}

function lastIndexWhere<T>(items: T[], predicate: (item: T) => boolean): number {
	for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i])) return i;
	return -1;
}

/** Index of the message the previous request ended with: the last user message before the last assistant one. */
function previousTurnEnd(messages: Rec[], userRoles: string[]): number {
	const lastAssistant = lastIndexWhere(messages, (message) => message.role === "assistant");
	return lastIndexWhere(messages.slice(0, lastAssistant), (message) => userRoles.includes(message.role));
}

describe("Anthropic Messages (Anthropic API, Claude on Vertex, OpenRouter's Claude)", () => {
	const cases: Array<{
		label: string;
		providerId: string;
		prefer: (model: Model<Api>) => boolean;
		env?: ProviderEnv;
	}> = [
		{
			// Full requests, as through the Hands egress proxy (message threads are api.anthropic.com only).
			label: "Anthropic API without message threads",
			providerId: "anthropic",
			prefer: (model) => model.id.startsWith("claude-sonnet-4-5"),
		},
		{
			label: "Claude on Vertex AI",
			providerId: "google-vertex-anthropic",
			prefer: (model) => model.id.startsWith("claude-sonnet-4-5"),
			env: { GOOGLE_CLOUD_PROJECT: "veyra-test", GOOGLE_CLOUD_LOCATION: "us-east5" },
		},
		{ label: "OpenRouter Claude", providerId: "openrouter", prefer: (model) => model.api === "anthropic-messages" },
	];

	for (const testCase of cases) {
		it(`${testCase.label}: four stable breakpoints and an append-only prefix`, async () => {
			const requests: Recorded[] = [];
			const catalogModel = pickModel(testCase.providerId, testCase.prefer) as Model<"anthropic-messages">;
			const model: Model<"anthropic-messages"> =
				testCase.providerId === "anthropic"
					? { ...catalogModel, compat: { ...catalogModel.compat, supportsMessageThreads: false } }
					: catalogModel;
			if (testCase.providerId === "google-vertex-anthropic") {
				const { setVertexTokenSource } = await import("../src/api/vertex-token.ts");
				setVertexTokenSource(async () => "ya29.cache-token");
			}
			const replies = await runThreeTurns(testCase.providerId, model, {
				apiKey: testCase.env ? undefined : API_KEY,
				env: testCase.env,
				fetch: turnFetch(
					(turn) => withTurnIds(anthropicMessagesSse(model.id), turn, ["toolu_01Conformance"]),
					requests,
				),
			});
			expect(requests).toHaveLength(3);
			const bodies = requests.map((request) => request.body);

			// The system prompt and the tool list are the same bytes on every turn, markers included.
			expectSameBytes(
				bodies.map((body) => body.system),
				"system",
			);
			expectSameBytes(
				bodies.map((body) => body.tools),
				"tools",
			);
			expect(bodies[0].system.at(-1).cache_control).toEqual({ type: "ephemeral" });
			expect(bodies[0].tools.at(-1).cache_control).toEqual({ type: "ephemeral" });

			expectAppendOnly(bodies.map((body) => body.messages));

			for (const [index, body] of bodies.entries()) {
				const messages = body.messages as Rec[];
				const paths = markerPaths(messages);
				expect(markerPaths(body).length, `request ${index + 1}: at most 4 breakpoints`).toBeLessThanOrEqual(4);
				// The last message always carries a breakpoint.
				expect(paths.some((path) => path.startsWith(`[${messages.length - 1}]`))).toBe(true);
				if (index === 0) {
					expect(paths).toHaveLength(1);
					continue;
				}
				// From the second turn on, the previous request's last message keeps its breakpoint, so the
				// cache entry the previous request wrote is read back even beyond the 20-block lookback.
				const previousEnd = previousTurnEnd(messages, ["user"]);
				expect(previousEnd).toBeGreaterThanOrEqual(0);
				expect(
					paths.some((path) => path.startsWith(`[${previousEnd}]`)),
					`request ${index + 1} marks message ${previousEnd}`,
				).toBe(true);
				expect(paths).toHaveLength(2);
				expect(markerPaths(body)).toHaveLength(4);
			}

			for (const reply of replies) {
				expect(reply.usage.cacheRead).toBe(CACHE_READ_TOKENS);
				expect(reply.usage.cacheWrite).toBe(CACHE_WRITE_TOKENS);
			}
		});
	}

	it("Anthropic API with message threads: a continue request sends only new messages, the last one marked", async () => {
		const requests: Recorded[] = [];
		const model = pickModel("anthropic", (entry) => entry.id.startsWith("claude-sonnet-4-5"));
		await runThreeTurns("anthropic", model, {
			apiKey: API_KEY,
			fetch: turnFetch(
				(turn) => withTurnIds(anthropicMessagesSse(model.id), turn, ["toolu_01Conformance"]),
				requests,
			),
		});
		expect(requests[0].body.thread).toEqual({ type: "create" });
		expect(requests[0].body.system.at(-1).cache_control).toEqual({ type: "ephemeral" });
		for (const request of requests.slice(1)) {
			expect(request.body.thread.type).toBe("continue");
			expect(request.body.system).toBeUndefined();
			const messages = request.body.messages as Rec[];
			expect(markerPaths(messages).some((path) => path.startsWith(`[${messages.length - 1}]`))).toBe(true);
			expect(markerPaths(request.body).length).toBeLessThanOrEqual(4);
		}
	});

	it("keeps a short user prompt in the same block form whether or not it holds the breakpoint", async () => {
		const requests: Recorded[] = [];
		const catalogModel = pickModel("anthropic", (entry) =>
			entry.id.startsWith("claude-sonnet-4-5"),
		) as Model<"anthropic-messages">;
		const model = { ...catalogModel, compat: { ...catalogModel.compat, supportsMessageThreads: false } };
		await runThreeTurns("anthropic", model, {
			apiKey: API_KEY,
			fetch: turnFetch(
				(turn) => withTurnIds(anthropicMessagesSse(model.id), turn, ["toolu_01Conformance"]),
				requests,
			),
		});
		// The first prompt holds the last-message breakpoint in request 1, the previous-turn breakpoint in
		// request 2 and no breakpoint in request 3: its wire form must not change between those.
		const firstPrompt = requests.map((request) => stripMarkers(request.body.messages[0]));
		expect(firstPrompt[0]).toEqual({ role: "user", content: [{ type: "text", text: "Open src/app.ts" }] });
		expectSameBytes(firstPrompt, "first prompt");
	});

	it("cacheRetention none sends no markers", async () => {
		const requests: Recorded[] = [];
		const model = pickModel("anthropic", (entry) => entry.id.startsWith("claude-sonnet-4-5"));
		await runThreeTurns("anthropic", model, {
			apiKey: API_KEY,
			cacheRetention: "none" as "short",
			fetch: turnFetch(
				(turn) => withTurnIds(anthropicMessagesSse(model.id), turn, ["toolu_01Conformance"]),
				requests,
			),
		});
		for (const request of requests) expect(markerPaths(request.body)).toEqual([]);
	});
});

describe("Amazon Bedrock ConverseStream", () => {
	let server: Server;
	let baseUrl: string;
	const received: Rec[] = [];
	const codec = new EventStreamCodec(
		(bytes) => new TextDecoder().decode(bytes),
		(text) => new TextEncoder().encode(text),
	);

	beforeAll(async () => {
		let turn = 0;
		server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				received.push(JSON.parse(body) as Rec);
				turn++;
				response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
				for (const event of bedrockConverseEvents()) {
					const eventBody = JSON.stringify(event.body).replaceAll("tooluse_conformance", `tooluse_t${turn}`);
					response.write(
						codec.encode({
							headers: {
								":event-type": { type: "string", value: event.type },
								":content-type": { type: "string", value: "application/json" },
								":message-type": { type: "string", value: "event" },
							},
							body: new TextEncoder().encode(eventBody),
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

	it("Claude on Bedrock: cache points on the system prompt, the last and the previous turn's message", async () => {
		const catalogModel = pickModel("amazon-bedrock", (entry) => entry.id.includes("anthropic.claude-sonnet-4-5"));
		const replies = await runThreeTurns(
			"amazon-bedrock",
			{ ...catalogModel, baseUrl },
			{
				env: {
					AWS_ACCESS_KEY_ID: "AKIDCACHE",
					AWS_SECRET_ACCESS_KEY: "cache-secret",
					AWS_BEDROCK_FORCE_HTTP1: "1",
				},
			},
		);
		expect(received).toHaveLength(3);
		expectSameBytes(
			received.map((body) => body.system),
			"system",
		);
		expectSameBytes(
			received.map((body) => body.toolConfig),
			"toolConfig",
		);
		expect(received[0].system.at(-1)).toEqual({ cachePoint: { type: "default" } });
		expectAppendOnly(received.map((body) => body.messages));
		for (const [index, body] of received.entries()) {
			const messages = body.messages as Rec[];
			const paths = markerPaths(messages);
			expect(markerPaths(body).length).toBeLessThanOrEqual(4);
			expect(messages.at(-1)!.content.at(-1)).toEqual({ cachePoint: { type: "default" } });
			if (index === 0) {
				expect(paths).toHaveLength(1);
				continue;
			}
			const previousEnd = previousTurnEnd(messages, ["user"]);
			expect(messages[previousEnd].content.at(-1), `request ${index + 1}`).toEqual({
				cachePoint: { type: "default" },
			});
			expect(paths).toHaveLength(2);
		}
		for (const reply of replies) {
			expect(reply.usage.cacheRead).toBe(CACHE_READ_TOKENS);
			expect(reply.usage.cacheWrite).toBe(CACHE_WRITE_TOKENS);
		}
	});
});

describe("OpenAI Responses (OpenAI, xAI)", () => {
	for (const providerId of ["openai", "xai"]) {
		it(`${providerId}: one prompt_cache_key per session and an append-only input`, async () => {
			const requests: Recorded[] = [];
			const model = pickModel(providerId, () => true);
			const replies = await runThreeTurns(providerId, model, {
				apiKey: API_KEY,
				fetch: turnFetch(
					(turn) => withTurnIds(openAIResponsesSse(model.id), turn, ["call_conformance", "fc_conformance"]),
					requests,
				),
			});
			const bodies = requests.map((request) => request.body);
			for (const body of bodies) expect(body.prompt_cache_key).toBe(SESSION_ID);
			expectSameBytes(
				bodies.map((body) => body.tools),
				"tools",
			);
			// The system prompt is the first input item (or `instructions`): covered by the prefix check.
			expectSameBytes(
				bodies.map((body) => body.instructions ?? null),
				"instructions",
			);
			expect(JSON.stringify(bodies[0].instructions ?? bodies[0].input[0])).toContain("You are Fingers");
			expectAppendOnly(bodies.map((body) => body.input));
			for (const reply of replies) expect(reply.usage.cacheRead).toBe(CACHE_READ_TOKENS);
		});
	}
});

describe("Chat Completions hosts with automatic caching (DeepSeek, OpenRouter, Kimi, Qwen)", () => {
	const cases: Array<{ providerId: string; usage: "openai" | "deepseek"; field: "reasoning" | "reasoning_content" }> =
		[
			{ providerId: "deepseek", usage: "deepseek", field: "reasoning_content" },
			{ providerId: "openrouter", usage: "openai", field: "reasoning" },
			{ providerId: "moonshotai", usage: "openai", field: "reasoning_content" },
			{ providerId: "qwen", usage: "openai", field: "reasoning_content" },
		];
	for (const testCase of cases) {
		it(`${testCase.providerId}: no markers, an append-only prefix, cache hits in usage`, async () => {
			const requests: Recorded[] = [];
			const model = pickModel(
				testCase.providerId,
				(entry) => entry.api === "openai-completions" && !entry.id.startsWith("anthropic/"),
			);
			const replies = await runThreeTurns(testCase.providerId, model, {
				apiKey: API_KEY,
				fetch: turnFetch(
					(turn) =>
						withTurnIds(
							openAICompletionsSse(model.id, { reasoningField: testCase.field, usage: testCase.usage }),
							turn,
							["call_conformance"],
						),
					requests,
				),
			});
			const bodies = requests.map((request) => request.body);
			for (const body of bodies) expect(markerPaths(body)).toEqual([]);
			expectSameBytes(
				bodies.map((body) => body.tools),
				"tools",
			);
			expectAppendOnly(bodies.map((body) => body.messages));
			if (testCase.providerId === "openrouter") {
				// OpenRouter keeps a session on one upstream so the upstream's own prefix cache can hit.
				for (const request of requests) expect(request.headers.get("x-session-id")).toBe(SESSION_ID);
			}
			for (const reply of replies) expect(reply.usage.cacheRead).toBe(CACHE_READ_TOKENS);
		});
	}
});

describe("Chat Completions with Anthropic-style markers (OpenRouter's Claude batch models)", () => {
	it("marks system, last tool, newest and previous turn's message, with stable message forms", async () => {
		const requests: Recorded[] = [];
		const model = pickModel(
			"openrouter",
			(entry) => entry.api === "openai-completions" && entry.id.startsWith("anthropic/claude"),
		);
		await runThreeTurns("openrouter", model, {
			apiKey: API_KEY,
			fetch: turnFetch(
				(turn) =>
					withTurnIds(openAICompletionsSse(model.id, { reasoningField: "reasoning", usage: "openai" }), turn, [
						"call_conformance",
					]),
				requests,
			),
		});
		const bodies = requests.map((request) => request.body);
		expectSameBytes(
			bodies.map((body) => body.tools),
			"tools",
		);
		expect(bodies[0].tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
		expectAppendOnly(bodies.map((body) => body.messages));
		for (const [index, body] of bodies.entries()) {
			const messages = body.messages as Rec[];
			const paths = markerPaths(messages);
			expect(markerPaths(body).length).toBeLessThanOrEqual(4);
			expect(paths.some((path) => path.startsWith("[0]"))).toBe(true);
			expect(paths.some((path) => path.startsWith(`[${messages.length - 1}]`))).toBe(true);
			if (index === 0) continue;
			const previousEnd = previousTurnEnd(messages, ["user", "tool"]);
			expect(
				paths.some((path) => path.startsWith(`[${previousEnd}]`)),
				`request ${index + 1}`,
			).toBe(true);
			expect(markerPaths(body)).toHaveLength(4);
		}
	});
});

describe("Google Gemini", () => {
	beforeEach(() => {
		resetGeminiContextCaches();
	});

	const gemini = () => pickModel("google", (entry) => entry.id === "gemini-2.5-pro");

	it("short retention: implicit caching, identical system instruction and tools, append-only contents", async () => {
		const requests: Recorded[] = [];
		const model = gemini();
		const replies = await runThreeTurns("google", model, {
			apiKey: API_KEY,
			fetch: turnFetch(() => geminiSse(), requests),
		});
		expect(requests.every((request) => request.url.includes(":streamGenerateContent"))).toBe(true);
		const bodies = requests.map((request) => request.body);
		for (const body of bodies) expect(body.cachedContent).toBeUndefined();
		expectSameBytes(
			bodies.map((body) => body.systemInstruction),
			"systemInstruction",
		);
		expectSameBytes(
			bodies.map((body) => body.tools),
			"tools",
		);
		expectAppendOnly(bodies.map((body) => body.contents));
		for (const reply of replies) expect(reply.usage.cacheRead).toBe(CACHE_READ_TOKENS);
	});

	function cacheApi(created: Rec[]) {
		return (url: string, body: Rec): Response | undefined => {
			if (!url.includes("/cachedContents")) return undefined;
			created.push(body);
			const name = `cachedContents/fingers-${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 12)}`;
			return new Response(
				JSON.stringify({
					name,
					model: body.model,
					expireTime: new Date(Date.now() + 3_600_000).toISOString(),
					usageMetadata: { totalTokenCount: 4200 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};
	}

	it("long retention: one context cache holds the system instruction and tools, every turn reuses it", async () => {
		const requests: Recorded[] = [];
		const created: Rec[] = [];
		const model = gemini();
		const replies = await runThreeTurns("google", model, {
			apiKey: API_KEY,
			cacheRetention: "long",
			fetch: turnFetch(() => geminiSse(), requests, cacheApi(created)),
		});
		expect(created).toHaveLength(1);
		const cache = created[0];
		expect(cache.model).toBe(`models/${model.id}`);
		expect(cache.ttl).toBe("3600s");
		expect(JSON.stringify(cache.systemInstruction)).toContain("You are Fingers, a coding agent.");
		expect(cache.tools[0].functionDeclarations.map((tool: Rec) => tool.name)).toEqual([TOOL_NAME, "write_file"]);

		const generate = requests.filter((request) => request.url.includes(":streamGenerateContent"));
		expect(generate).toHaveLength(3);
		for (const request of generate) {
			expect(request.body.cachedContent).toMatch(/^cachedContents\/fingers-/);
			expect(request.body.systemInstruction).toBeUndefined();
			expect(request.body.tools).toBeUndefined();
			expect(request.body.toolConfig).toBeUndefined();
		}
		expectSameBytes(
			generate.map((request) => request.body.cachedContent),
			"cachedContent",
		);
		expectAppendOnly(generate.map((request) => request.body.contents));
		// The API key never goes into the cache's display name.
		expect(JSON.stringify(cache)).not.toContain(API_KEY);
		for (const reply of replies) expect(reply.usage.cacheRead).toBe(CACHE_READ_TOKENS);
	});

	it("long retention: a prompt below the cacheable minimum makes no cache call", async () => {
		const requests: Recorded[] = [];
		const created: Rec[] = [];
		const model = gemini();
		const context = normalizeContext({
			systemPrompt: "Short prompt.",
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: [readFileTool],
		});
		const reply = await provider("google")
			.streamSimple(model, context, {
				apiKey: API_KEY,
				cacheRetention: "long",
				sessionId: SESSION_ID,
				maxRetries: 0,
				fetch: turnFetch(() => geminiSse(), requests, cacheApi(created)),
			})
			.result();
		expect(reply.errorMessage).toBeUndefined();
		expect(created).toHaveLength(0);
		expect(requests[0].body.systemInstruction).toBeDefined();
		expect(requests[0].body.cachedContent).toBeUndefined();
	});

	it("long retention: a refused cache is not asked for again on the next turn", async () => {
		const requests: Recorded[] = [];
		const model = gemini();
		let createCalls = 0;
		const replies = await runThreeTurns("google", model, {
			apiKey: API_KEY,
			cacheRetention: "long",
			fetch: turnFetch(
				() => geminiSse(),
				requests,
				(url) => {
					if (!url.includes("/cachedContents")) return undefined;
					createCalls++;
					return new Response(
						JSON.stringify({
							error: {
								code: 400,
								message: "Cached content is too small. total_token_count=3412, min_total_token_count=4096",
							},
						}),
						{ status: 400, headers: { "content-type": "application/json" } },
					);
				},
			),
		});
		expect(createCalls).toBe(1);
		// The refusal is recorded on the reply of the request that asked for the cache.
		expect(replies[0].diagnostics?.map((diagnostic) => diagnostic.type)).toEqual(["gemini_context_cache_refused"]);
		expect(replies[1].diagnostics).toBeUndefined();
		const generate = requests.filter((request) => request.url.includes(":streamGenerateContent"));
		expect(generate).toHaveLength(3);
		for (const request of generate) {
			expect(request.body.cachedContent).toBeUndefined();
			expect(request.body.systemInstruction).toBeDefined();
		}
	});

	it("long retention: a failed cache call or an expired cache falls back to the uncached request", async () => {
		const requests: Recorded[] = [];
		const model = gemini();
		let generateCalls = 0;
		const fetch = turnFetch(
			() => geminiSse(),
			requests,
			(url, body) => {
				if (url.includes("/cachedContents")) {
					return new Response(
						JSON.stringify({
							name: "cachedContents/fingers-gone",
							model: body.model,
							expireTime: new Date(Date.now() + 3_600_000).toISOString(),
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				generateCalls++;
				if (body.cachedContent) {
					return new Response(
						JSON.stringify({ error: { code: 403, message: "CachedContent not found (or permission denied)" } }),
						{ status: 403, headers: { "content-type": "application/json" } },
					);
				}
				return undefined;
			},
		);
		const context = normalizeContext({
			systemPrompt: SYSTEM_PROMPT,
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: [readFileTool],
		});
		const reply = await provider("google")
			.streamSimple(model, context, { apiKey: API_KEY, cacheRetention: "long", maxRetries: 0, fetch })
			.result();
		expect(reply.errorMessage).toBeUndefined();
		expect(reply.diagnostics?.map((diagnostic) => diagnostic.type)).toEqual(["gemini_context_cache_fallback"]);
		expect(generateCalls).toBe(2);
		const last = requests.at(-1)!;
		expect(last.body.cachedContent).toBeUndefined();
		expect(last.body.systemInstruction).toBeDefined();
	});
});
