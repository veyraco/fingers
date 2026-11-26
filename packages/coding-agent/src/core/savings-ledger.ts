/**
 * The savings ledger: what each token-saving technique saved in this conversation, in estimated tokens.
 *
 * Techniques write an entry each time they save something (ee token saving: a read served from the cache, a trimmed
 * tool output, an edit sent as a diff instead of the whole file, an old tool result pruned from the context). The
 * end-of-task report (F17) adds up the entries per technique. The ledger holds no file content and no tool output:
 * only the technique, the token estimate and the tool call it came from.
 */

/** The techniques that write to the ledger. */
export const SAVINGS_TECHNIQUES = ["read_cache", "output_trim", "diff_edit", "context_prune"] as const;
export type SavingsTechnique = (typeof SAVINGS_TECHNIQUES)[number];

/** One saving, as a technique reports it. */
export interface SavingsEntry {
	technique: SavingsTechnique;
	/** Estimated tokens the model did not have to read (or write), chars/4 like the compaction estimate. */
	tokens: number;
	/** The tool call the saving came from. */
	toolCallId?: string;
	toolName?: string;
}

/** An entry as the ledger keeps it. */
export interface SavingsRecord extends SavingsEntry {
	/** Epoch ms. */
	at: number;
}

export interface SavingsTotals {
	/** Tokens and entries per technique; a technique with no entry is 0. */
	byTechnique: Record<SavingsTechnique, { tokens: number; count: number }>;
	tokens: number;
}

/** chars/4, rounded up: the estimate compaction uses for message sizes. */
export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function isTechnique(value: unknown): value is SavingsTechnique {
	return typeof value === "string" && (SAVINGS_TECHNIQUES as readonly string[]).includes(value);
}

export class SavingsLedger {
	private records: SavingsRecord[] = [];
	private readonly listeners = new Set<() => void>();
	private readonly now: () => number;

	constructor(options: { now?: () => number } = {}) {
		this.now = options.now ?? Date.now;
	}

	/** Add an entry. One with an unknown technique or no positive whole number of tokens is ignored. */
	record(entry: SavingsEntry): void {
		if (!isTechnique(entry.technique)) return;
		const tokens = Math.floor(entry.tokens);
		if (!Number.isFinite(tokens) || tokens <= 0) return;
		const record: SavingsRecord = { technique: entry.technique, tokens, at: this.now() };
		if (typeof entry.toolCallId === "string") record.toolCallId = entry.toolCallId;
		if (typeof entry.toolName === "string") record.toolName = entry.toolName;
		this.records.push(record);
		for (const listener of this.listeners) listener();
	}

	entries(): readonly SavingsRecord[] {
		return [...this.records];
	}

	totals(): SavingsTotals {
		const byTechnique = Object.fromEntries(
			SAVINGS_TECHNIQUES.map((technique) => [technique, { tokens: 0, count: 0 }]),
		) as SavingsTotals["byTechnique"];
		let tokens = 0;
		for (const record of this.records) {
			byTechnique[record.technique].tokens += record.tokens;
			byTechnique[record.technique].count += 1;
			tokens += record.tokens;
		}
		return { byTechnique, tokens };
	}

	/** Start over, for another conversation. */
	clear(): void {
		if (this.records.length === 0) return;
		this.records = [];
		for (const listener of this.listeners) listener();
	}

	/** Called after every change. Returns the unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}
