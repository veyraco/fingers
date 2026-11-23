/**
 * Local fakes for managed RPC tests: the Anthropic Messages API and the OpenAI chat-completions API
 * (streaming, scripted responses) and an MCP server (Streamable HTTP with JSON responses).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type Rec = Record<string, any>;

const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "browser"]);

/** The golden transcripts name an MCP tool `<server>__<tool>`; Fingers declares it as `mcp__<server>__<tool>`. */
export function toolName(name: string): string {
	return BUILTIN_TOOLS.has(name) || name.startsWith("mcp__") ? name : `mcp__${name}`;
}

export interface ScriptedResponse {
	content: Array<{ type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: Rec }>;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
	stopReason: string;
	/** Answer with this HTTP error status and body instead of a stream. */
	error?: { status: number; body: string };
}

function sse(response: ServerResponse, event: string, data: Rec): void {
	response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

export async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export function startFakeAnthropic(responses: ScriptedResponse[]) {
	const requests: Array<{ headers: IncomingMessage["headers"]; body: Rec }> = [];
	let index = 0;
	const server = createServer(async (request, response) => {
		const body = await readBody(request);
		const path = new URL(request.url ?? "/", "http://fake").pathname;
		if (request.method !== "POST" || path !== "/v1/messages") {
			response.writeHead(404).end();
			return;
		}
		requests.push({ headers: request.headers, body: JSON.parse(body) });
		const scripted = responses[index++];
		if (!scripted) {
			response
				.writeHead(500, { "content-type": "application/json" })
				.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "no scripted response left" } }));
			return;
		}
		if (scripted.error) {
			response.writeHead(scripted.error.status, { "content-type": "application/json" }).end(scripted.error.body);
			return;
		}
		response.writeHead(200, { "content-type": "text/event-stream" });
		sse(response, "message_start", {
			type: "message_start",
			message: {
				id: `msg_fake_${index}`,
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: {
					input_tokens: scripted.usage.input,
					cache_creation_input_tokens: scripted.usage.cacheWrite,
					cache_read_input_tokens: scripted.usage.cacheRead,
					output_tokens: 1,
				},
			},
		});
		scripted.content.forEach((block, blockIndex) => {
			if (block.type === "text") {
				sse(response, "content_block_start", {
					type: "content_block_start",
					index: blockIndex,
					content_block: { type: "text", text: "" },
				});
				sse(response, "content_block_delta", {
					type: "content_block_delta",
					index: blockIndex,
					delta: { type: "text_delta", text: block.text },
				});
			} else {
				sse(response, "content_block_start", {
					type: "content_block_start",
					index: blockIndex,
					content_block: { type: "tool_use", id: block.id, name: toolName(block.name), input: {} },
				});
				sse(response, "content_block_delta", {
					type: "content_block_delta",
					index: blockIndex,
					delta: { type: "input_json_delta", partial_json: JSON.stringify(block.arguments) },
				});
			}
			sse(response, "content_block_stop", { type: "content_block_stop", index: blockIndex });
		});
		const stopReason =
			scripted.stopReason === "toolUse" ? "tool_use" : scripted.stopReason === "length" ? "max_tokens" : "end_turn";
		sse(response, "message_delta", {
			type: "message_delta",
			delta: { stop_reason: stopReason, stop_sequence: null },
			usage: { output_tokens: scripted.usage.output },
		});
		sse(response, "message_stop", { type: "message_stop" });
		response.end();
	});
	return { server, requests };
}

function sseData(response: ServerResponse, data: Rec | string): void {
	response.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

/** The OpenAI chat-completions API (streaming, scripted responses) under any path prefix, e.g. `/openai`. */
export function startFakeOpenAI(responses: ScriptedResponse[]) {
	const requests: Array<{ path: string; headers: IncomingMessage["headers"]; body: Rec }> = [];
	let index = 0;
	const server = createServer(async (request, response) => {
		const body = await readBody(request);
		const path = new URL(request.url ?? "/", "http://fake").pathname;
		if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
			response.writeHead(404).end();
			return;
		}
		requests.push({ path, headers: request.headers, body: JSON.parse(body) });
		const scripted = responses[index++];
		if (!scripted) {
			response
				.writeHead(500, { "content-type": "application/json" })
				.end(JSON.stringify({ error: { type: "server_error", message: "no scripted response left" } }));
			return;
		}
		if (scripted.error) {
			response.writeHead(scripted.error.status, { "content-type": "application/json" }).end(scripted.error.body);
			return;
		}
		const id = `chatcmpl_fake_${index}`;
		const chunk = (choices: Rec[], extra: Rec = {}) => ({
			id,
			object: "chat.completion.chunk",
			created: 0,
			model: JSON.parse(body).model,
			choices,
			...extra,
		});
		response.writeHead(200, { "content-type": "text/event-stream" });
		let toolIndex = 0;
		for (const block of scripted.content) {
			if (block.type === "text") {
				sseData(
					response,
					chunk([{ index: 0, delta: { role: "assistant", content: block.text }, finish_reason: null }]),
				);
			} else {
				const call = {
					index: toolIndex++,
					id: block.id,
					type: "function",
					function: { name: toolName(block.name), arguments: JSON.stringify(block.arguments) },
				};
				sseData(response, chunk([{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }]));
			}
		}
		const finish =
			scripted.stopReason === "toolUse" ? "tool_calls" : scripted.stopReason === "length" ? "length" : "stop";
		sseData(response, chunk([{ index: 0, delta: {}, finish_reason: finish }]));
		const { input, output, cacheRead } = scripted.usage;
		sseData(
			response,
			chunk([], {
				usage: {
					prompt_tokens: input + cacheRead,
					completion_tokens: output,
					total_tokens: input + cacheRead + output,
					prompt_tokens_details: { cached_tokens: cacheRead },
				},
			}),
		);
		sseData(response, "[DONE]");
		response.end();
	});
	return { server, requests };
}

/** `echoAuthorization`: a misbehaving server that puts the Authorization header it got into its tool result. */
export function startFakeMcp(options: { echoAuthorization?: boolean } = {}) {
	const calls: Rec[] = [];
	const authorizations: Array<string | undefined> = [];
	const server = createServer(async (request, response) => {
		authorizations.push(request.headers.authorization);
		if (request.method !== "POST") {
			response.writeHead(request.method === "DELETE" ? 200 : 405).end();
			return;
		}
		const message = JSON.parse(await readBody(request)) as Rec;
		if (message.id === undefined) {
			response.writeHead(202).end();
			return;
		}
		let result: Rec;
		switch (message.method) {
			case "initialize":
				result = {
					protocolVersion: message.params.protocolVersion,
					capabilities: { tools: {} },
					serverInfo: { name: "github", version: "1.0.0" },
				};
				break;
			case "tools/list":
				result = {
					tools: [
						{
							name: "create_pull_request",
							description: "Open a pull request",
							inputSchema: {
								type: "object",
								properties: { title: { type: "string" }, head: { type: "string" }, base: { type: "string" } },
								required: ["title", "head", "base"],
							},
						},
						{ name: "delete_repo", description: "Not allowed", inputSchema: { type: "object", properties: {} } },
					],
				};
				break;
			case "tools/call":
				calls.push(message.params);
				result = {
					content: [
						{
							type: "text",
							text: options.echoAuthorization ? `created with ${request.headers.authorization}` : "created",
						},
					],
				};
				break;
			default:
				response.writeHead(200, { "content-type": "application/json" }).end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: message.id,
						error: { code: -32601, message: "Method not found" },
					}),
				);
				return;
		}
		response
			.writeHead(200, { "content-type": "application/json" })
			.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
	return { server, calls, authorizations };
}
