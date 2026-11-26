// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * Diff edits: with token saving on, the system prompt asks the model to change existing files with edit (only the
 * changed text) instead of rewriting them with write, and each successful edit is counted in the savings ledger as
 * the tokens a whole-file write of the result would have cost, minus the tokens of the edit call's replacements.
 */
import { readFile, stat } from "node:fs/promises";
import type { EeToolResult } from "@veyraco/fingers";
import { estimateTokens } from "./text.ts";

/** Files above this size are not read back to count a saving. */
export const DIFF_EDIT_MAX_FILE_BYTES = 2 * 1024 * 1024;

export const DIFF_EDIT_GUIDELINES: Readonly<Record<string, readonly string[]>> = {
	edit: ["Token saving is on: change an existing file with edit, sending only the text that changes."],
	write: ["Token saving is on: do not rewrite an existing file with write to change part of it; use edit."],
};

/** Tokens a successful edit saved against writing the whole file, or undefined. */
export async function diffEditSaving(result: EeToolResult): Promise<number | undefined> {
	if (result.toolName !== "edit" || result.nested || result.isError || !result.path) return undefined;
	try {
		const file = await stat(result.path);
		if (!file.isFile() || file.size > DIFF_EDIT_MAX_FILE_BYTES) return undefined;
		const written = await readFile(result.path, "utf8");
		const sent = JSON.stringify(result.input.edits ?? [result.input.oldText, result.input.newText]);
		const saved = estimateTokens(written) - estimateTokens(sent);
		return saved > 0 ? saved : undefined;
	} catch {
		return undefined;
	}
}
