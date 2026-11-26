// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * Saving context (F15): old tool results are pruned in stages before the core's compaction has to summarise, and a
 * compaction shows what it should save before it runs and what it saved after.
 *
 * Pruning runs at the end of a turn on the view the core hands over. The core compacts above
 * `limit = contextWindow - reserveTokens`; below it, two stages prune:
 *
 * - stage 1, from half of the limit: tool results older than the most recent `keep = min(keepRecentTokens, 40% of
 *   limit)` tokens of the conversation (core compaction keeps keepRecentTokens too);
 * - stage 2, from three quarters of the limit (the recent part itself is large): tool results older than the most
 *   recent `keep / 2` tokens.
 *
 * A pruned result is replaced by a one-line note (which tool, what it was about, how big it was, run it again to get
 * it back), saved in the session as a context edit, so it stays pruned for every later request and for compaction,
 * and the provider's prompt cache breaks only when a batch is pruned. A batch is pruned only when it frees at least
 * `max(1000, 5% of limit)` tokens and, in stage 1, twice what the provider has to cache again after the first pruned
 * result (so the cache break pays for itself); results smaller than 200 tokens and the last two tool results are
 * never pruned. Only the core's compaction summarises; it now summarises the pruned context, so
 * its own call is smaller too.
 */
import type {
	EeCompactionOutcome,
	EeCompactionPreview,
	EeContextEdit,
	EeContextEntry,
	EeContextView,
} from "@veyraco/fingers";
import { estimateTokens } from "./text.ts";

export interface PruneStage {
	/** The stage starts when the context reaches this share of the compaction limit. */
	at: number;
	/** Results inside the most recent `keep × this` tokens are kept, keep = min(keepRecentTokens, 40% of limit). */
	keepFactor: number;
}

export const PRUNE_STAGES: readonly PruneStage[] = [
	{ at: 0.5, keepFactor: 1 },
	{ at: 0.75, keepFactor: 0.5 },
];

/** The recent part stage 1 keeps, as a share of the compaction limit at most. */
export const PRUNE_KEEP_SHARE = 0.4;

/** Results smaller than this are not worth a note and a cache break. */
export const PRUNE_MIN_RESULT_TOKENS = 200;
/** The most recent tool results that are never pruned, whatever their size. */
export const PRUNE_KEEP_LAST_RESULTS = 2;

/** Where the core compacts: contextWindow - reserveTokens (the whole window when the reserve leaves nothing). */
export function compactionLimit(view: Pick<EeContextView, "contextWindow" | "compaction">): number {
	const limit = view.contextWindow - view.compaction.reserveTokens;
	return limit > 0 ? limit : view.contextWindow;
}

/**
 * In stage 1, a batch must free at least this many times what the provider has to cache again after it: with a cache
 * write at about 1.25 and a read at 0.1 of an input token, the batch then pays for itself within about six requests.
 */
export const PRUNE_REWRITE_FACTOR = 2;

/** The least a batch must free to be pruned. */
export function minimumBatchTokens(limit: number): number {
	return Math.max(1000, Math.round(0.05 * limit));
}

function contentText(entry: EeContextEntry): string {
	return (entry.content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function shorten(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function displayPath(path: string, cwd: string): string {
	return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

/** The note a pruned tool result is replaced with. */
export function prunedNote(entry: EeContextEntry, cwd: string): string {
	const input = entry.input ?? {};
	let what = "";
	if (entry.path) what = ` of ${displayPath(entry.path, cwd)}`;
	else if (typeof input.command === "string") what = ` of \`${shorten(input.command, 80)}\``;
	else if (typeof input.pattern === "string") what = ` for \`${shorten(input.pattern, 80)}\``;
	const images = (entry.content ?? []).filter((block) => block.type === "image").length;
	const text = contentText(entry);
	const size = [
		text.length > 0 ? plural(text.split("\n").length, "line") : "",
		images > 0 ? plural(images, "image") : "",
	]
		.filter(Boolean)
		.join(", ");
	const kind = entry.isError ? `${entry.toolName ?? "tool"} error` : `${entry.toolName ?? "tool"} result`;
	return `[pruned by token saving] This earlier ${kind}${what} (${size}, about ${entry.tokens} tokens) was taken out of the context to save tokens. Run the tool again if you still need it.`;
}

export interface PrunedResult {
	edit: EeContextEdit;
	entry: EeContextEntry;
	savedTokens: number;
}

/** The stage the context is in, or undefined below the first stage. */
export function pruneStage(view: EeContextView): PruneStage | undefined {
	const limit = compactionLimit(view);
	let stage: PruneStage | undefined;
	for (const candidate of PRUNE_STAGES) if (view.tokens >= candidate.at * limit) stage = candidate;
	return stage;
}

/** The tool results to prune at the end of this turn (empty when no stage applies or the batch is too small). */
export function planPrune(view: EeContextView): PrunedResult[] {
	const stage = pruneStage(view);
	if (!stage) return [];
	const limit = compactionLimit(view);
	const keep = Math.floor(stage.keepFactor * Math.min(view.compaction.keepRecentTokens, PRUNE_KEEP_SHARE * limit));

	// From the newest entry back: everything until `keep` tokens are reached is recent, and so is the entry that
	// crosses it; so are the last few tool results.
	const recent = new Set<string>();
	let tokens = 0;
	let results = 0;
	for (let index = view.entries.length - 1; index >= 0; index--) {
		const entry = view.entries[index];
		if (!entry) continue;
		const isResult = entry.role === "toolResult";
		if (tokens < keep || (isResult && results < PRUNE_KEEP_LAST_RESULTS)) recent.add(entry.id);
		tokens += entry.tokens;
		if (isResult) results++;
	}

	const pruned: PrunedResult[] = [];
	for (const entry of view.entries) {
		if (recent.has(entry.id) || entry.role !== "toolResult" || entry.edited || !entry.content) continue;
		if (entry.tokens < PRUNE_MIN_RESULT_TOKENS) continue;
		const note = prunedNote(entry, view.cwd);
		const savedTokens = entry.tokens - estimateTokens(note);
		if (savedTokens <= 0) continue;
		pruned.push({ edit: { targetId: entry.id, content: [{ type: "text", text: note }] }, entry, savedTokens });
	}
	const freed = pruned.reduce((sum, result) => sum + result.savedTokens, 0);
	if (freed < minimumBatchTokens(limit)) return [];
	// Stage 1 only: the provider writes everything after the first pruned result to its cache again (a write costs
	// about 12 cache reads), so wait until the batch is worth that; from stage 2 on, avoiding compaction is.
	if (stage === PRUNE_STAGES[0]) {
		const first = view.entries.findIndex((entry) => entry.id === pruned[0]?.edit.targetId);
		const rewritten = view.entries.slice(first).reduce((sum, entry) => sum + entry.tokens, 0) - freed;
		if (freed < PRUNE_REWRITE_FACTOR * rewritten) return [];
	}
	return pruned;
}

/** The summary a compaction is expected to write, in tokens (file lists included). */
export function expectedSummaryTokens(preview: EeCompactionPreview): number {
	const cap = preview.summaryMaxTokens > 0 ? preview.summaryMaxTokens : Number.POSITIVE_INFINITY;
	const base = Math.min(cap, Math.max(300, Math.round(0.04 * preview.summarizedTokens)));
	// An update of an earlier summary keeps about its size; its file lists are counted again below.
	let written = Math.max(base, preview.previousSummaryTokens - preview.fileListTokens);
	if (preview.splitTurn) written += Math.round(base / 2);
	return written + preview.fileListTokens;
}

/** What a compaction should save: the summarised messages and the earlier summary, minus the new summary. */
export function estimateCompactionSaving(preview: EeCompactionPreview): number {
	return Math.max(0, preview.summarizedTokens + preview.previousSummaryTokens - expectedSummaryTokens(preview));
}

const formatTokens = (tokens: number) => Math.round(tokens).toLocaleString("en-US");

export function compactionEstimateLine(preview: EeCompactionPreview): string {
	const saving = estimateCompactionSaving(preview);
	return `Token saving: this compaction should save about ${formatTokens(saving)} tokens (${formatTokens(preview.tokensBefore)} → about ${formatTokens(Math.max(0, preview.tokensBefore - saving))}).`;
}

export function compactionOutcomeLine(outcome: EeCompactionOutcome, estimate: number | undefined): string {
	const saved = outcome.tokensBefore - outcome.tokensAfter;
	const line = `Token saving: compaction saved ${formatTokens(saved)} tokens (${formatTokens(outcome.tokensBefore)} → ${formatTokens(outcome.tokensAfter)})`;
	return estimate === undefined ? `${line}.` : `${line}; the estimate was ${formatTokens(estimate)}.`;
}
