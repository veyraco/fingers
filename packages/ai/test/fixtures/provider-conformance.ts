/**
 * Wire fixtures for the first-version Fingers providers, one per wire protocol, in the exact shapes the
 * providers stream: Anthropic Messages SSE, OpenAI Responses SSE, OpenAI Chat Completions SSE (with the
 * reasoning field each host uses), Gemini streamGenerateContent SSE, and Bedrock ConverseStream
 * (binary AWS event stream). Every fixture is one assistant turn that thinks, writes text, and calls the
 * `read_file` tool, with prompt-cache usage, so a single replay checks streaming, tools, thinking and usage.
 *
 * The token numbers are the same in every fixture where the protocol allows it, so the expected usage is
 * shared: 120 new input tokens, 4096 cache reads, 87 output tokens (Anthropic-style hosts add 2048 cache
 * writes).
 */

export const THINKING = "The user wants the file, so I read it first.";
export const TEXT = "I'll read src/app.ts.";
export const TOOL_NAME = "read_file";
export const TOOL_ARGS = { path: "src/app.ts" };
export const INPUT_TOKENS = 120;
export const CACHE_READ_TOKENS = 4096;
export const CACHE_WRITE_TOKENS = 2048;
export const OUTPUT_TOKENS = 87;

function sse(events: Array<{ event?: string; data: unknown }>): string {
	return events
		.map(
			({ event, data }) =>
				`${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
		)
		.join("");
}

/** Anthropic Messages API (api.anthropic.com and Claude on Vertex AI streamRawPredict). */
export function anthropicMessagesSse(model: string): string {
	return sse([
		{
			event: "message_start",
			data: {
				type: "message_start",
				message: {
					id: "msg_01FingersConformance",
					type: "message",
					role: "assistant",
					model,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: {
						input_tokens: INPUT_TOKENS,
						cache_creation_input_tokens: CACHE_WRITE_TOKENS,
						cache_read_input_tokens: CACHE_READ_TOKENS,
						output_tokens: 1,
					},
				},
			},
		},
		{
			event: "content_block_start",
			data: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "", signature: "" },
			},
		},
		{
			event: "content_block_delta",
			data: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: THINKING.slice(0, 20) },
			},
		},
		{
			event: "content_block_delta",
			data: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: THINKING.slice(20) },
			},
		},
		{
			event: "content_block_delta",
			data: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "signature_delta", signature: "EqQBCkYIBxgCKkDsig" },
			},
		},
		{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
		{
			event: "content_block_start",
			data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
		},
		{
			event: "content_block_delta",
			data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: TEXT } },
		},
		{ event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
		{
			event: "content_block_start",
			data: {
				type: "content_block_start",
				index: 2,
				content_block: { type: "tool_use", id: "toolu_01Conformance", name: TOOL_NAME, input: {} },
			},
		},
		{
			event: "content_block_delta",
			data: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":' } },
		},
		{
			event: "content_block_delta",
			data: {
				type: "content_block_delta",
				index: 2,
				delta: { type: "input_json_delta", partial_json: '"src/app.ts"}' },
			},
		},
		{ event: "content_block_stop", data: { type: "content_block_stop", index: 2 } },
		{
			event: "message_delta",
			data: {
				type: "message_delta",
				delta: { stop_reason: "tool_use", stop_sequence: null },
				usage: { output_tokens: OUTPUT_TOKENS },
			},
		},
		{ event: "message_stop", data: { type: "message_stop" } },
	]);
}

/** OpenAI Responses API (OpenAI, xAI). */
export function openAIResponsesSse(model: string): string {
	const reasoning = {
		type: "reasoning",
		id: "rs_conformance",
		summary: [{ type: "summary_text", text: THINKING }],
		encrypted_content: "gAAAAABconformance",
	};
	const message = {
		type: "message",
		id: "msg_conformance",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: TEXT, annotations: [] }],
	};
	const call = {
		type: "function_call",
		id: "fc_conformance",
		call_id: "call_conformance",
		name: TOOL_NAME,
		arguments: JSON.stringify(TOOL_ARGS),
		status: "completed",
	};
	const response = (status: string, output: unknown[], usage?: unknown) => ({
		id: "resp_conformance",
		object: "response",
		created_at: 1_763_600_000,
		model,
		status,
		output,
		...(usage ? { usage } : {}),
	});
	return sse([
		{ data: { type: "response.created", sequence_number: 0, response: response("in_progress", []) } },
		{
			data: {
				type: "response.output_item.added",
				sequence_number: 1,
				output_index: 0,
				item: { type: "reasoning", id: reasoning.id, summary: [] },
			},
		},
		{
			data: {
				type: "response.reasoning_summary_part.added",
				sequence_number: 2,
				output_index: 0,
				item_id: reasoning.id,
				summary_index: 0,
				part: { type: "summary_text", text: "" },
			},
		},
		{
			data: {
				type: "response.reasoning_summary_text.delta",
				sequence_number: 3,
				output_index: 0,
				item_id: reasoning.id,
				summary_index: 0,
				delta: THINKING,
			},
		},
		{
			data: {
				type: "response.reasoning_summary_part.done",
				sequence_number: 4,
				output_index: 0,
				item_id: reasoning.id,
				summary_index: 0,
				part: { type: "summary_text", text: THINKING },
			},
		},
		{ data: { type: "response.output_item.done", sequence_number: 5, output_index: 0, item: reasoning } },
		{
			data: {
				type: "response.output_item.added",
				sequence_number: 6,
				output_index: 1,
				item: { ...message, status: "in_progress", content: [] },
			},
		},
		{
			data: {
				type: "response.content_part.added",
				sequence_number: 7,
				output_index: 1,
				item_id: message.id,
				content_index: 0,
				part: { type: "output_text", text: "", annotations: [] },
			},
		},
		{
			data: {
				type: "response.output_text.delta",
				sequence_number: 8,
				output_index: 1,
				item_id: message.id,
				content_index: 0,
				delta: TEXT,
			},
		},
		{ data: { type: "response.output_item.done", sequence_number: 9, output_index: 1, item: message } },
		{
			data: {
				type: "response.output_item.added",
				sequence_number: 10,
				output_index: 2,
				item: { ...call, arguments: "", status: "in_progress" },
			},
		},
		{
			data: {
				type: "response.function_call_arguments.delta",
				sequence_number: 11,
				output_index: 2,
				item_id: call.id,
				delta: '{"path":',
			},
		},
		{
			data: {
				type: "response.function_call_arguments.delta",
				sequence_number: 12,
				output_index: 2,
				item_id: call.id,
				delta: '"src/app.ts"}',
			},
		},
		{
			data: {
				type: "response.function_call_arguments.done",
				sequence_number: 13,
				output_index: 2,
				item_id: call.id,
				arguments: call.arguments,
			},
		},
		{ data: { type: "response.output_item.done", sequence_number: 14, output_index: 2, item: call } },
		{
			data: {
				type: "response.completed",
				sequence_number: 15,
				response: response("completed", [reasoning, message, call], {
					input_tokens: INPUT_TOKENS + CACHE_READ_TOKENS,
					input_tokens_details: { cached_tokens: CACHE_READ_TOKENS },
					output_tokens: OUTPUT_TOKENS,
					output_tokens_details: { reasoning_tokens: 40 },
					total_tokens: INPUT_TOKENS + CACHE_READ_TOKENS + OUTPUT_TOKENS,
				}),
			},
		},
	]);
}

/** Which field a Chat Completions host streams reasoning in. */
export type CompletionsReasoningField = "reasoning" | "reasoning_content";

/** OpenAI Chat Completions (OpenRouter, Moonshot Kimi, DeepSeek, Qwen, any OpenAI-compatible endpoint). */
export function openAICompletionsSse(
	model: string,
	options: { reasoningField: CompletionsReasoningField; usage: "openai" | "deepseek" },
): string {
	const chunk = (
		delta: Record<string, unknown>,
		finishReason: string | null = null,
		extra: Record<string, unknown> = {},
	) => ({
		id: "chatcmpl-conformance",
		object: "chat.completion.chunk",
		created: 1_763_600_000,
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		...extra,
	});
	const usage =
		options.usage === "deepseek"
			? {
					prompt_tokens: INPUT_TOKENS + CACHE_READ_TOKENS,
					prompt_cache_hit_tokens: CACHE_READ_TOKENS,
					prompt_cache_miss_tokens: INPUT_TOKENS,
					completion_tokens: OUTPUT_TOKENS,
					total_tokens: INPUT_TOKENS + CACHE_READ_TOKENS + OUTPUT_TOKENS,
				}
			: {
					prompt_tokens: INPUT_TOKENS + CACHE_READ_TOKENS,
					prompt_tokens_details: { cached_tokens: CACHE_READ_TOKENS },
					completion_tokens: OUTPUT_TOKENS,
					completion_tokens_details: { reasoning_tokens: 40 },
					total_tokens: INPUT_TOKENS + CACHE_READ_TOKENS + OUTPUT_TOKENS,
				};
	return sse([
		{ data: chunk({ role: "assistant", content: "" }) },
		{ data: chunk({ [options.reasoningField]: THINKING.slice(0, 20) }) },
		{ data: chunk({ [options.reasoningField]: THINKING.slice(20) }) },
		{ data: chunk({ content: TEXT }) },
		{
			data: chunk({
				tool_calls: [
					{ index: 0, id: "call_conformance", type: "function", function: { name: TOOL_NAME, arguments: "" } },
				],
			}),
		},
		{ data: chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }) },
		{ data: chunk({ tool_calls: [{ index: 0, function: { arguments: '"src/app.ts"}' } }] }) },
		{ data: chunk({}, "tool_calls") },
		{ data: { ...chunk({}), choices: [], usage } },
		{ data: "[DONE]" },
	]);
}

/** Gemini API streamGenerateContent?alt=sse. */
export function geminiSse(): string {
	const usageMetadata = {
		promptTokenCount: INPUT_TOKENS + CACHE_READ_TOKENS,
		cachedContentTokenCount: CACHE_READ_TOKENS,
		candidatesTokenCount: OUTPUT_TOKENS - 40,
		thoughtsTokenCount: 40,
		totalTokenCount: INPUT_TOKENS + CACHE_READ_TOKENS + OUTPUT_TOKENS,
	};
	return sse([
		{ data: { candidates: [{ content: { role: "model", parts: [{ text: THINKING, thought: true }] }, index: 0 }] } },
		{ data: { candidates: [{ content: { role: "model", parts: [{ text: TEXT }] }, index: 0 }] } },
		{
			data: {
				candidates: [
					{
						content: {
							role: "model",
							parts: [
								{ functionCall: { name: TOOL_NAME, args: TOOL_ARGS }, thoughtSignature: "Q29uZm9ybWFuY2U=" },
							],
						},
						finishReason: "STOP",
						index: 0,
					},
				],
				usageMetadata,
				modelVersion: "gemini",
				responseId: "conformance",
			},
		},
	]);
}

/** Bedrock ConverseStream events (encoded to the binary event stream by the test). */
export function bedrockConverseEvents(): Array<{ type: string; body: unknown }> {
	return [
		{ type: "messageStart", body: { role: "assistant" } },
		{ type: "contentBlockDelta", body: { contentBlockIndex: 0, delta: { reasoningContent: { text: THINKING } } } },
		{
			type: "contentBlockDelta",
			body: { contentBlockIndex: 0, delta: { reasoningContent: { signature: "EqQBCkYIBxgCKkDsig" } } },
		},
		{ type: "contentBlockStop", body: { contentBlockIndex: 0 } },
		{ type: "contentBlockDelta", body: { contentBlockIndex: 1, delta: { text: TEXT } } },
		{ type: "contentBlockStop", body: { contentBlockIndex: 1 } },
		{
			type: "contentBlockStart",
			body: { contentBlockIndex: 2, start: { toolUse: { toolUseId: "tooluse_conformance", name: TOOL_NAME } } },
		},
		{ type: "contentBlockDelta", body: { contentBlockIndex: 2, delta: { toolUse: { input: '{"path":' } } } },
		{ type: "contentBlockDelta", body: { contentBlockIndex: 2, delta: { toolUse: { input: '"src/app.ts"}' } } } },
		{ type: "contentBlockStop", body: { contentBlockIndex: 2 } },
		{ type: "messageStop", body: { stopReason: "tool_use" } },
		{
			type: "metadata",
			body: {
				usage: {
					inputTokens: INPUT_TOKENS,
					outputTokens: OUTPUT_TOKENS,
					totalTokens: INPUT_TOKENS + CACHE_READ_TOKENS + CACHE_WRITE_TOKENS + OUTPUT_TOKENS,
					cacheReadInputTokens: CACHE_READ_TOKENS,
					cacheWriteInputTokens: CACHE_WRITE_TOKENS,
				},
				metrics: { latencyMs: 412 },
			},
		},
	];
}
