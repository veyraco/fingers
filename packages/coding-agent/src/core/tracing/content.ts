/**
 * Span payloads (only with content capture on): messages in the GenAI conventions' structured form
 * (`{ role, parts: [{ type, content | id, name, arguments | result }] }`), as JSON strings, bounded in size.
 */
import type { AgentMessage } from "@veyraco/fingers-agent";

/** The largest payload attribute Fingers writes (characters of JSON). Older messages go first when it is too large. */
export const MAX_PAYLOAD_CHARS = 64 * 1024;

type Part =
	| { type: "text"; content: string }
	| { type: "reasoning"; content: string }
	| { type: "tool_call"; id: string; name: string; arguments: unknown }
	| { type: "tool_call_response"; id: string; result: string }
	| { type: "blob"; modality: "image"; mime_type?: string };

interface GenAiMessage {
	role: "user" | "assistant" | "tool" | "system";
	parts: Part[];
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function userParts(content: unknown): Part[] {
	if (typeof content === "string") return [{ type: "text", content }];
	if (!Array.isArray(content)) return [];
	const parts: Part[] = [];
	for (const part of content) {
		if (part?.type === "text" && typeof part.text === "string") parts.push({ type: "text", content: part.text });
		// The image itself never goes into a span.
		else if (part?.type === "image") parts.push({ type: "blob", modality: "image", mime_type: part.mimeType });
	}
	return parts;
}

/** One transcript message in the GenAI form; undefined for entries the model does not see as a turn. */
export function toGenAiMessage(message: AgentMessage): GenAiMessage | undefined {
	const record = message as { role?: string; content?: unknown };
	switch (record.role) {
		case "user":
			return { role: "user", parts: userParts(record.content) };
		case "assistant": {
			const parts: Part[] = [];
			for (const part of Array.isArray(record.content) ? record.content : []) {
				if (part?.type === "text") parts.push({ type: "text", content: part.text });
				else if (part?.type === "thinking" && !part.redacted)
					parts.push({ type: "reasoning", content: part.thinking });
				else if (part?.type === "toolCall")
					parts.push({ type: "tool_call", id: part.id, name: part.name, arguments: part.arguments });
			}
			return { role: "assistant", parts };
		}
		case "toolResult": {
			const result = message as { toolCallId?: string; content?: unknown };
			return {
				role: "tool",
				parts: [{ type: "tool_call_response", id: result.toolCallId ?? "", result: textOf(result.content) }],
			};
		}
		default:
			return undefined;
	}
}

/** A JSON payload of at most `max` characters: the newest messages that fit; undefined when none does. */
export function messagesPayload(messages: readonly AgentMessage[], max = MAX_PAYLOAD_CHARS): string | undefined {
	const converted = messages.map(toGenAiMessage).filter((message): message is GenAiMessage => !!message);
	for (let start = 0; start < converted.length; start++) {
		const json = JSON.stringify(converted.slice(start));
		if (json.length <= max) return json;
	}
	return undefined;
}

/** Masks a payload's whole text (the tracer's credential and secret masking). */
type PayloadMask = (text: string) => string;

/**
 * Text cut to `max` characters, with a marker saying so. `mask` runs on the whole text before the cut: a credential
 * that straddles the cut would otherwise lose the tail its pattern needs and leave as a partial key.
 */
export function boundedText(text: string, max = MAX_PAYLOAD_CHARS, mask?: PayloadMask): string {
	const masked = mask ? mask(text) : text;
	return masked.length <= max ? masked : `${masked.slice(0, max - 20)}… [truncated]`;
}

/** A tool result's text (images left out), masked, then bounded. */
export function toolResultText(result: unknown, mask?: PayloadMask): string {
	const content = (result as { content?: unknown } | undefined)?.content;
	return boundedText(textOf(content), MAX_PAYLOAD_CHARS, mask);
}

/** A value as JSON (tool arguments), masked, then bounded. */
export function boundedJson(value: unknown, mask?: PayloadMask): string {
	let json: string;
	try {
		json = JSON.stringify(value ?? {});
	} catch {
		json = "{}";
	}
	return boundedText(json, MAX_PAYLOAD_CHARS, mask);
}
