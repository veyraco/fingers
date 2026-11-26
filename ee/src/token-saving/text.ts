// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
import type { EeToolResult } from "@veyraco/fingers";

/** chars/4, rounded up: the core's estimate (compaction and the savings ledger). */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** The text of a result that is exactly one text block; undefined for images or several blocks. */
export function singleText(content: EeToolResult["content"]): string | undefined {
	if (content.length !== 1) return undefined;
	const [block] = content;
	return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
}
