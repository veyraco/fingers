// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * Token saving: no duplicate reads, trimmed tool outputs, diff edits (F14); old tool results pruned in stages before
 * compaction, and a saving estimate for each compaction (F15). Each technique writes what it saved to the core's
 * savings ledger (EeHost.recordSaving), which the end-of-task report adds up.
 */
import type {
	EeCompactionOutcome,
	EeCompactionPreview,
	EeContextEdit,
	EeContextView,
	EeHost,
	EeToolHooks,
	EeToolResult,
	EeToolResultChange,
} from "@veyraco/fingers";
import { compactionEstimateLine, compactionOutcomeLine, estimateCompactionSaving, planPrune } from "./context.ts";
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
	/** The estimate shown when the running compaction started. */
	private compactionEstimate: number | undefined;
	readonly hooks: EeToolHooks;

	constructor(options: TokenSavingOptions = {}) {
		this.readCache = options.readCache ?? new ReadCache();
		this.trimOptions = { outputDir: options.outputDir };
		this.hooks = {
			toolResult: (result) => this.onToolResult(result),
			toolGuidelines: () => ({ ...READ_CACHE_GUIDELINES, ...DIFF_EDIT_GUIDELINES }),
			contextReset: () => this.readCache.clear(),
			contextEdits: (view) => this.onTurnEnd(view),
			beforeCompact: (preview) => this.onBeforeCompact(preview),
			afterCompact: (outcome) => this.onAfterCompact(outcome),
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
		this.compactionEstimate = undefined;
	}

	/** Prune old tool results in stages; a pruned read is no longer in the context, so its file reads fresh again. */
	private onTurnEnd(view: EeContextView): EeContextEdit[] {
		const pruned = planPrune(view);
		for (const { entry, savedTokens } of pruned) {
			if (entry.toolName === "read" && entry.path) this.readCache.forgetFile(entry.path);
			this.host?.recordSaving({
				technique: "context_prune",
				tokens: savedTokens,
				toolCallId: entry.toolCallId,
				toolName: entry.toolName,
			});
		}
		return pruned.map(({ edit }) => edit);
	}

	private onBeforeCompact(preview: EeCompactionPreview): string {
		this.compactionEstimate = estimateCompactionSaving(preview);
		return compactionEstimateLine(preview);
	}

	private onAfterCompact(outcome: EeCompactionOutcome): string {
		const estimate = this.compactionEstimate;
		this.compactionEstimate = undefined;
		return compactionOutcomeLine(outcome, estimate);
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
