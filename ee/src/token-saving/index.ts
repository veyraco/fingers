// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * Token saving, part 1 (F14): no duplicate reads, trimmed tool outputs, diff edits. Each technique writes what it
 * saved to the core's savings ledger (EeHost.recordSaving), which the end-of-task report adds up.
 */
import type { EeHost, EeToolHooks, EeToolResult, EeToolResultChange } from "@veyraco/fingers";
import { DIFF_EDIT_GUIDELINES, diffEditSaving } from "./diff-edit.ts";
import { ReadCache } from "./read-cache.ts";
import { type TrimOptions, trimToolOutput } from "./trim.ts";

export const READ_CACHE_GUIDELINES: Readonly<Record<string, readonly string[]>> = {
	read: [
		"Token saving is on: reading a file again that has not changed since your last read of it returns a short “from cache, read once” note instead of the text, which is in that earlier result; reading it once more returns the text.",
	],
};

export interface TokenSavingOptions extends TrimOptions {
	readCache?: ReadCache;
}

export class TokenSaving {
	readonly readCache: ReadCache;
	private host: EeHost | undefined;
	private readonly trimOptions: TrimOptions;
	readonly hooks: EeToolHooks;

	constructor(options: TokenSavingOptions = {}) {
		this.readCache = options.readCache ?? new ReadCache();
		this.trimOptions = { outputDir: options.outputDir };
		this.hooks = {
			toolResult: (result) => this.onToolResult(result),
			toolGuidelines: () => ({ ...READ_CACHE_GUIDELINES, ...DIFF_EDIT_GUIDELINES }),
			contextReset: () => this.readCache.clear(),
		};
	}

	/** Use this host's ledger from now on (each activation hands a new host). */
	attach(host: EeHost | undefined): void {
		this.host = host;
	}

	/** Token saving went off: forget the reads, so nothing assumes them when it comes back on. */
	reset(): void {
		this.host = undefined;
		this.readCache.clear();
	}

	private async onToolResult(result: EeToolResult): Promise<EeToolResultChange | undefined> {
		if (result.nested) return undefined;
		switch (result.toolName) {
			case "read": {
				const hit = await this.readCache.onRead(result);
				if (!hit) return undefined;
				this.record("read_cache", hit.savedTokens, result);
				return hit.change;
			}
			case "edit":
			case "write": {
				if (result.path) this.readCache.forgetFile(result.path);
				const saved = await diffEditSaving(result);
				if (saved !== undefined) this.record("diff_edit", saved, result);
				return undefined;
			}
			default: {
				const trimmed = trimToolOutput(result, this.trimOptions);
				if (!trimmed) return undefined;
				this.record("output_trim", trimmed.savedTokens, result);
				return trimmed.change;
			}
		}
	}

	private record(technique: "read_cache" | "output_trim" | "diff_edit", tokens: number, result: EeToolResult): void {
		this.host?.recordSaving({ technique, tokens, toolCallId: result.toolCallId, toolName: result.toolName });
	}
}
