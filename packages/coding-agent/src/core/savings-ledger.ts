/**
 * The savings ledger: what each token-saving technique saved in this conversation, in estimated tokens.
 *
 * Techniques write an entry each time they save something (ee token saving: a read served from the cache, a trimmed
 * tool output, an edit sent as a diff instead of the whole file, an old tool result pruned from the context, a
 * sub-task run on a cheaper model). The savings report (`/savings`, core/savings-report.ts) adds up the entries per
 * technique. The ledger holds no file content and no tool output: only the technique, the token estimate, the dollars
 * saved, the model in use and the tool call it came from. The built-in `edition` extension keeps the entries in the
 * session file (custom entries {@link SAVINGS_ENTRY_TYPE}), so a resumed or forked conversation keeps its savings.
 */

/** The techniques that write to the ledger. */
export const SAVINGS_TECHNIQUES = ["read_cache", "output_trim", "diff_edit", "context_prune", "model_routing"] as const;
export type SavingsTechnique = (typeof SAVINGS_TECHNIQUES)[number];

/** One saving, as a technique reports it. */
export interface SavingsEntry {
	technique: SavingsTechnique;
	/**
	 * Estimated tokens the model did not have to read (or write), chars/4 like the compaction estimate. 0 for a saving
	 * that is only in dollars (model routing: the same tokens on a cheaper model).
	 */
	tokens: number;
	/** Dollars saved at list price, when the technique knows them (model routing). */
	costUsd?: number;
	/** The tool call the saving came from. */
	toolCallId?: string;
	toolName?: string;
}

/** An entry as the ledger keeps it. */
export interface SavingsRecord extends SavingsEntry {
	/** Epoch ms. */
	at: number;
	/** The model in use when the saving was made (its list price priced a token-only saving). */
	provider?: string;
	model?: string;
}

/** The session file's custom entry type that holds one {@link SavingsRecord}. */
export const SAVINGS_ENTRY_TYPE = "fingers.savings";

/** The list price of the model in use, in dollars per million tokens. */
export interface SavingsPricing {
	provider: string;
	model: string;
	inputPerMTok: number;
	outputPerMTok: number;
}

/**
 * What a token-only saving is worth at `pricing`: the tokens the model did not have to read, at its input price, or
 * for a diff edit the tokens it did not have to write, at its output price. Undefined without a price.
 */
export function savingCostUsd(
	technique: SavingsTechnique,
	tokens: number,
	pricing: SavingsPricing | undefined,
): number | undefined {
	if (!pricing || tokens <= 0) return undefined;
	const perMTok = technique === "diff_edit" ? pricing.outputPerMTok : pricing.inputPerMTok;
	if (!Number.isFinite(perMTok) || perMTok <= 0) return undefined;
	return (tokens * perMTok) / 1_000_000;
}

export interface SavingsTotals {
	/** Tokens, dollars and entries per technique; a technique with no entry is 0. */
	byTechnique: Record<SavingsTechnique, { tokens: number; costUsd: number; count: number }>;
	tokens: number;
	costUsd: number;
}

/** chars/4, rounded up: the estimate compaction uses for message sizes. */
export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function isTechnique(value: unknown): value is SavingsTechnique {
	return typeof value === "string" && (SAVINGS_TECHNIQUES as readonly string[]).includes(value);
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

const MAX_TEXT = 200;

function shortText(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT ? value : undefined;
}

/**
 * A record read back from a session file, or undefined when it is not one. Session files can be edited by hand, so
 * every field is checked and only the known ones are kept.
 */
export function parseSavingsRecord(data: unknown): SavingsRecord | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const value = data as Record<string, unknown>;
	if (!isTechnique(value.technique)) return undefined;
	const tokens =
		typeof value.tokens === "number" && Number.isSafeInteger(value.tokens) && value.tokens > 0 ? value.tokens : 0;
	const costUsd = positiveNumber(value.costUsd);
	if (tokens === 0 && costUsd === undefined) return undefined;
	const at = typeof value.at === "number" && Number.isFinite(value.at) && value.at >= 0 ? value.at : 0;
	const record: SavingsRecord = { technique: value.technique, tokens, at };
	if (costUsd !== undefined) record.costUsd = costUsd;
	const toolCallId = shortText(value.toolCallId);
	if (toolCallId !== undefined) record.toolCallId = toolCallId;
	const toolName = shortText(value.toolName);
	if (toolName !== undefined) record.toolName = toolName;
	const provider = shortText(value.provider);
	if (provider !== undefined) record.provider = provider;
	const model = shortText(value.model);
	if (model !== undefined) record.model = model;
	return record;
}

export class SavingsLedger {
	private records: SavingsRecord[] = [];
	private readonly listeners = new Set<() => void>();
	private readonly recordListeners = new Set<(record: SavingsRecord) => void>();
	private readonly now: () => number;
	private pricing: (() => SavingsPricing | undefined) | undefined;

	constructor(options: { now?: () => number } = {}) {
		this.now = options.now ?? Date.now;
	}

	/**
	 * The list price of the model in use, asked at every entry (the built-in `edition` extension sets it). A token-only
	 * entry is priced with it; without it such an entry is worth $0.
	 */
	setPricing(source: (() => SavingsPricing | undefined) | undefined): () => void {
		this.pricing = source;
		// Puts no price back, unless another source took over since.
		return () => {
			if (this.pricing === source) this.pricing = undefined;
		};
	}

	private currentPricing(): SavingsPricing | undefined {
		try {
			return this.pricing?.();
		} catch {
			return undefined;
		}
	}

	/**
	 * Add an entry. One with an unknown technique, or with neither a positive whole number of tokens nor a positive
	 * dollar amount, is ignored. An entry without dollars is priced at the list price of the model in use.
	 */
	record(entry: SavingsEntry): void {
		if (!isTechnique(entry.technique)) return;
		const floored = Math.floor(entry.tokens);
		const tokens = Number.isFinite(floored) && floored > 0 ? floored : 0;
		const pricing = this.currentPricing();
		const costUsd = positiveNumber(entry.costUsd) ?? savingCostUsd(entry.technique, tokens, pricing);
		if (tokens === 0 && costUsd === undefined) return;
		const record: SavingsRecord = { technique: entry.technique, tokens, at: this.now() };
		if (costUsd !== undefined) record.costUsd = costUsd;
		if (typeof entry.toolCallId === "string") record.toolCallId = entry.toolCallId;
		if (typeof entry.toolName === "string") record.toolName = entry.toolName;
		if (pricing) {
			record.provider = pricing.provider;
			record.model = pricing.model;
		}
		this.records.push(record);
		for (const listener of this.recordListeners) listener(record);
		for (const listener of this.listeners) listener();
	}

	/** The number of entries; entries()[n..] are the ones added since a count of n. */
	get size(): number {
		return this.records.length;
	}

	/** Use these records instead (a conversation's records read back from its session file). */
	load(records: readonly SavingsRecord[]): void {
		if (records.length === 0 && this.records.length === 0) return;
		this.records = records.map((record) => ({ ...record }));
		for (const listener of this.listeners) listener();
	}

	entries(): readonly SavingsRecord[] {
		return [...this.records];
	}

	totals(): SavingsTotals {
		const byTechnique = Object.fromEntries(
			SAVINGS_TECHNIQUES.map((technique) => [technique, { tokens: 0, costUsd: 0, count: 0 }]),
		) as SavingsTotals["byTechnique"];
		let tokens = 0;
		let costUsd = 0;
		for (const record of this.records) {
			byTechnique[record.technique].tokens += record.tokens;
			byTechnique[record.technique].costUsd += record.costUsd ?? 0;
			byTechnique[record.technique].count += 1;
			tokens += record.tokens;
			costUsd += record.costUsd ?? 0;
		}
		return { byTechnique, tokens, costUsd };
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

	/** Called with each new entry (not for load or clear). Returns the unsubscribe function. */
	onRecord(listener: (record: SavingsRecord) => void): () => void {
		this.recordListeners.add(listener);
		return () => this.recordListeners.delete(listener);
	}
}
