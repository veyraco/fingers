/**
 * The token-saving report (canvas FingersTuiSavings): what each technique saved in this conversation, in tokens and in
 * dollars at list price, next to what the conversation spent.
 *
 * Prompt caching is core: its row comes from the usage the providers reported (tokens read from the cache, and what
 * that saved against the model's input price, less the cache-write premium). The other rows are ee token saving and
 * come from the savings ledger, one row per technique; their sums are the ledger's totals. Everything here is pure, so
 * the report of a recorded conversation is the same report every time.
 */
import type { AssistantMessage } from "@veyraco/fingers-ai";
import { sessionUsageTotals } from "./budget.ts";
import { SAVINGS_TECHNIQUES, type SavingsTechnique, type SavingsTotals } from "./savings-ledger.ts";
import type { SessionEntry } from "./session-manager.ts";
import { cacheHitPercent } from "./usage-totals.ts";

/** The list prices the report needs, in dollars per million tokens (ModelRuntime satisfies it). */
export interface SavingsPriceSource {
	getModel(provider: string, modelId: string): { cost: { input: number; cacheRead: number } } | undefined;
}

/** Whether ee token saving could add to the report, as the gate says. */
export type TokenSavingState = "on" | "signed_out" | "off";

type SavingsRowId = "prompt_caching" | SavingsTechnique;

interface SavingsReportRow {
	id: SavingsRowId;
	label: string;
	tokens: number;
	costUsd: number;
	/** Entries in the ledger (cache reads for prompt caching). */
	count: number;
}

export interface SavingsReport {
	/** Prompt caching first, then the ee techniques in the canvas order; only rows that saved something. */
	rows: SavingsReportRow[];
	/** Prompt caching alone (core), for the "without sign-in" line. */
	caching: { tokens: number; costUsd: number };
	/** The ee rows together: equal to the ledger's totals. */
	tokenSaving: { tokens: number; costUsd: number; count: number };
	savedTokens: number;
	savedUsd: number;
	spentUsd: number;
	/** Prompt tokens (new input, cache reads and writes) and output tokens. */
	tokensIn: number;
	tokensOut: number;
	cacheHitPercent?: number;
	/** saved / (spent + saved), whole percent; undefined until something is saved in dollars. */
	lessPercent?: number;
	/** What each provider was paid for, most first; sub-agents are "<provider> (sub-tasks)", summaries and other tools "other". */
	byProvider: { provider: string; costUsd: number }[];
	budget?: { spentUsd: number; capUsd: number };
	state: TokenSavingState;
	eyesLink?: string;
	title?: string;
	/** From the first to the last message of the conversation. */
	durationMs?: number;
	/** Distinct files the edit and write tools touched. */
	filesChanged: number;
}

export interface SavingsReportInput {
	/** The conversation: the session's current branch. */
	entries: readonly SessionEntry[];
	/** The savings ledger's totals for the same conversation. */
	ledger: SavingsTotals;
	prices: SavingsPriceSource;
	state: TokenSavingState;
	budget?: { spentUsd: number; capUsd: number };
	eyesLink?: string;
	title?: string;
}

/** Row labels in the canvas order; the read cache label carries its count. */
const ROW_ORDER: readonly SavingsRowId[] = [
	"prompt_caching",
	"model_routing",
	"context_prune",
	"output_trim",
	"read_cache",
	"diff_edit",
];

function rowLabel(id: SavingsRowId, count: number): string {
	switch (id) {
		case "prompt_caching":
			return "Prompt caching (every provider)";
		case "model_routing":
			return "Cheaper model for sub-tasks";
		case "context_prune":
			return "Context pruning before compaction";
		case "output_trim":
			return "Tool-output trimming";
		case "read_cache":
			return `No duplicate file reads (${count} skipped)`;
		case "diff_edit":
			return "Diff edits instead of rewrites";
	}
}

function finite(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * What prompt caching saved on one model call: the tokens read from the cache at the input price, less what they cost
 * as cache reads, less the premium the cache writes cost over plain input. Unpriced models save tokens only.
 */
function cachingSaving(message: AssistantMessage, prices: SavingsPriceSource): { tokens: number; costUsd: number } {
	const usage = message.usage;
	const tokens = Math.max(0, finite(usage.cacheRead));
	let model: ReturnType<SavingsPriceSource["getModel"]>;
	try {
		model = prices.getModel(message.provider, message.model);
	} catch {
		model = undefined;
	}
	const inputPerMTok = finite(model?.cost.input);
	if (inputPerMTok <= 0) return { tokens, costUsd: 0 };
	const readSaving = (tokens * inputPerMTok) / 1_000_000 - finite(usage.cost.cacheRead);
	const writes = Math.max(0, finite(usage.cacheWrite));
	const writePremium = finite(usage.cost.cacheWrite) - (writes * inputPerMTok) / 1_000_000;
	return { tokens, costUsd: readSaving - writePremium };
}

function entryTime(entry: SessionEntry): number | undefined {
	const time = Date.parse(entry.timestamp);
	return Number.isFinite(time) ? time : undefined;
}

/** The cost of each child of an `agents` tool result (its details), by provider. */
function subagentCosts(toolName: string, details: unknown): { provider: string; costUsd: number }[] {
	if (toolName !== "agents" || !details || typeof details !== "object") return [];
	const agents = (details as { agents?: unknown }).agents;
	if (!Array.isArray(agents)) return [];
	const costs: { provider: string; costUsd: number }[] = [];
	for (const agent of agents) {
		const provider = (agent as { model?: { provider?: unknown } })?.model?.provider;
		const cost = (agent as { usage?: { cost?: { total?: unknown } } })?.usage?.cost?.total;
		if (typeof provider !== "string" || provider.length === 0 || typeof cost !== "number") continue;
		const costUsd = finite(cost);
		if (costUsd > 0) costs.push({ provider, costUsd });
	}
	return costs;
}

export function computeSavingsReport(input: SavingsReportInput): SavingsReport {
	const caching = { tokens: 0, costUsd: 0, count: 0 };
	const byProvider = new Map<string, number>();
	const files = new Set<string>();
	let first: number | undefined;
	let last: number | undefined;
	const addProvider = (provider: string, cost: number) => {
		if (cost <= 0) return;
		byProvider.set(provider, (byProvider.get(provider) ?? 0) + cost);
	};

	for (const entry of input.entries) {
		if (entry.type === "message") {
			const time = entryTime(entry);
			if (time !== undefined) {
				first = first === undefined ? time : Math.min(first, time);
				last = last === undefined ? time : Math.max(last, time);
			}
			const message = entry.message;
			if (message.role === "assistant") {
				addProvider(message.provider, finite(message.usage.cost.total));
				// Cache writes cost a premium even on a call that read nothing from the cache.
				const saving = cachingSaving(message, input.prices);
				caching.tokens += saving.tokens;
				caching.costUsd += saving.costUsd;
				if (saving.tokens > 0) caching.count += 1;
				for (const part of message.content) {
					if (part.type !== "toolCall" || (part.name !== "edit" && part.name !== "write")) continue;
					const path = part.arguments.path;
					if (typeof path === "string" && path.length > 0) files.add(path);
				}
			} else if (message.role === "toolResult" && message.usage) {
				// Sub-agents: each child's calls under its provider, marked as sub-tasks; anything else is "other".
				let rest = finite(message.usage.cost.total);
				for (const child of subagentCosts(message.toolName, message.details)) {
					addProvider(`${child.provider} (sub-tasks)`, child.costUsd);
					rest -= child.costUsd;
				}
				if (rest > 1e-12) addProvider("other", rest);
			}
		} else if (entry.type === "usage") {
			addProvider(entry.provider, finite(entry.usage.cost.total));
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			addProvider("other", finite(entry.usage.cost.total));
		}
	}

	const rows: SavingsReportRow[] = [];
	for (const id of ROW_ORDER) {
		if (id === "prompt_caching") {
			if (caching.tokens > 0 || caching.costUsd !== 0)
				rows.push({ id, label: rowLabel(id, caching.count), ...caching });
			continue;
		}
		const totals = input.ledger.byTechnique[id];
		if (!totals || totals.count === 0) continue;
		rows.push({ id, label: rowLabel(id, totals.count), ...totals });
	}

	const tokenSaving = { tokens: 0, costUsd: 0, count: 0 };
	for (const technique of SAVINGS_TECHNIQUES) {
		const totals = input.ledger.byTechnique[technique];
		tokenSaving.tokens += totals.tokens;
		tokenSaving.costUsd += totals.costUsd;
		tokenSaving.count += totals.count;
	}

	const usage = sessionUsageTotals(input.entries);
	const savedTokens = caching.tokens + tokenSaving.tokens;
	const savedUsd = caching.costUsd + tokenSaving.costUsd;
	const spentUsd = usage.cost;
	const report: SavingsReport = {
		rows,
		caching: { tokens: caching.tokens, costUsd: caching.costUsd },
		tokenSaving,
		savedTokens,
		savedUsd,
		spentUsd,
		tokensIn: usage.input + usage.cacheRead + usage.cacheWrite,
		tokensOut: usage.output,
		byProvider: [...byProvider]
			.map(([provider, costUsd]) => ({ provider, costUsd }))
			.sort((a, b) => (a.provider === "other" ? 1 : b.provider === "other" ? -1 : b.costUsd - a.costUsd)),
		state: input.state,
		filesChanged: files.size,
	};
	const hit = cacheHitPercent(usage);
	if (hit !== undefined) report.cacheHitPercent = hit;
	if (savedUsd > 0 && spentUsd + savedUsd > 0)
		report.lessPercent = Math.round((savedUsd / (spentUsd + savedUsd)) * 100);
	if (input.budget) report.budget = input.budget;
	if (input.eyesLink) report.eyesLink = input.eyesLink;
	if (input.title) report.title = input.title;
	if (first !== undefined && last !== undefined && last > first) report.durationMs = last - first;
	return report;
}

// =============================================================================
// Text
// =============================================================================

/** The tones the terminal maps to theme colors. */
export type ReportTone = "text" | "dim" | "muted" | "success" | "accent";

interface ReportSegment {
	text: string;
	tone: ReportTone;
	bold?: boolean;
}

type ReportLine = ReportSegment[];

/** Token counts as the status line shows them: 940, 61.2k, 1.21M. */
function formatReportTokens(count: number): string {
	if (count < 1000) return Math.round(count).toString();
	if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(2)}M`;
}

/** Dollars as the status line shows them: two decimals, three below one cent; a negative saving keeps its sign. */
function formatReportUsd(usd: number): string {
	const sign = usd < 0 ? "-" : "";
	const value = Math.abs(usd);
	return `${sign}$${value > 0 && value < 0.01 ? value.toFixed(3) : value.toFixed(2)}`;
}

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const NAME_WIDTH = 36;
const NUMBER_WIDTH = 12;
const MAX_BAR = 26;
const MAX_RULE = 96;

const seg = (text: string, tone: ReportTone = "text", bold = false): ReportSegment =>
	bold ? { text, tone, bold } : { text, tone };

function padEnd(text: string, width: number): string {
	return text.length >= width ? `${text.slice(0, width - 2)}… ` : text.padEnd(width);
}

/** Bars scale with dollars saved, or with tokens when nothing is priced; the largest row gets the longest bar. */
function barLengths(rows: readonly SavingsReportRow[]): number[] {
	const byCost = rows.some((row) => row.costUsd > 0);
	const value = (row: SavingsReportRow) => Math.max(0, byCost ? row.costUsd : row.tokens);
	const max = Math.max(0, ...rows.map(value));
	return rows.map((row) => (max > 0 && value(row) > 0 ? Math.max(1, Math.round((value(row) / max) * MAX_BAR)) : 0));
}

/** The lines of the report, `width` cells wide at most (the rule shortens; rows are 64 cells plus the bar). */
export function savingsReportLines(report: SavingsReport, width = 120): ReportLine[] {
	const rule = "─".repeat(Math.max(10, Math.min(MAX_RULE, width - 4)));
	const lines: ReportLine[] = [];

	const facts: string[] = [];
	if (report.title) facts.push(report.title);
	if (report.durationMs !== undefined) facts.push(formatDuration(report.durationMs));
	if (report.filesChanged > 0)
		facts.push(`${report.filesChanged} ${report.filesChanged === 1 ? "file" : "files"} changed`);
	lines.push([
		seg("Token saving report", "text", true),
		...(facts.length ? [seg(`  ·  ${facts.join("  ·  ")}`, "dim")] : []),
	]);
	if (report.eyesLink) lines.push([seg("  Trace sent to Eyes: ", "dim"), seg(report.eyesLink, "accent")]);
	lines.push([]);

	if (report.rows.length === 0) {
		lines.push([seg("  Nothing saved yet in this conversation.", "dim")]);
	} else {
		lines.push([
			seg(
				`  ${"technique".padEnd(NAME_WIDTH)}${"tokens saved".padStart(NUMBER_WIDTH)}${"cost saved".padStart(NUMBER_WIDTH)}`,
				"dim",
				true,
			),
		]);
		lines.push([seg(`  ${rule}`, "muted")]);
		const bars = barLengths(report.rows);
		report.rows.forEach((row, index) => {
			const tokens = row.tokens > 0 ? formatReportTokens(row.tokens) : "—";
			const cost = row.costUsd !== 0 ? formatReportUsd(row.costUsd) : "—";
			const bar = bars[index] ?? 0;
			lines.push([
				seg(`  ${padEnd(row.label, NAME_WIDTH)}${tokens.padStart(NUMBER_WIDTH)}${cost.padStart(NUMBER_WIDTH)}`),
				...(bar > 0 ? [seg(`   ${"█".repeat(bar)}`, "success")] : []),
			]);
		});
		lines.push([seg(`  ${rule}`, "muted")]);
		lines.push([
			seg(`  ${"Saved".padEnd(NAME_WIDTH)}`, "text", true),
			seg(formatReportTokens(report.savedTokens).padStart(NUMBER_WIDTH), "success", true),
			seg(formatReportUsd(report.savedUsd).padStart(NUMBER_WIDTH), "success", true),
			...(report.lessPercent !== undefined && report.lessPercent > 0
				? [seg(`   ${report.lessPercent}% less than without these savings`, "dim")]
				: []),
		]);
	}
	lines.push([]);

	const spent: ReportLine = [seg("  Spent      ", "dim"), seg(formatReportUsd(report.spentUsd), "text", true)];
	if (report.budget) spent.push(seg(` of the ${formatReportUsd(report.budget.capUsd)} task budget`, "dim"));
	spent.push(
		seg("   ·   ", "dim"),
		seg(`${formatReportTokens(report.tokensIn)} tokens in`),
		seg("  ·  ", "muted"),
		seg(`${formatReportTokens(report.tokensOut)} out`),
	);
	if (report.cacheHitPercent !== undefined) {
		spent.push(seg("  ·  cache hit ", "dim"), seg(`${Math.floor(report.cacheHitPercent)}%`, "success", true));
	}
	lines.push(spent);
	if (report.byProvider.length > 0) {
		const providers: ReportLine = [seg("  By provider ", "dim")];
		report.byProvider.forEach((entry, index) => {
			if (index > 0) providers.push(seg("  ·  ", "muted"));
			providers.push(seg(`${entry.provider} ${formatReportUsd(entry.costUsd)}`));
		});
		lines.push(providers);
	}
	lines.push([]);
	lines.push([seg(`  ${withoutSignInText(report)}`, "muted")]);
	return lines;
}

/** The line under the numbers (canvas: "Without sign-in you would have saved only ..."). */
export function withoutSignInText(report: SavingsReport): string {
	switch (report.state) {
		case "on": {
			const caching =
				report.caching.tokens > 0
					? ` (${formatReportTokens(report.caching.tokens)} tokens, ${formatReportUsd(report.caching.costUsd)})`
					: "";
			return `Without sign-in you would have saved only what prompt caching saved${caching}; the other rows are ee token saving.`;
		}
		case "signed_out":
			return "Core only: prompt caching is on. fingers login turns on token saving when your organization’s Veyra tier includes it.";
		case "off":
			return "Token saving is off for this sign-in (not in your organization’s tier, or Fingers is off), so only prompt caching saved.";
	}
}

/** The report as plain text (tests, logs). */
export function savingsReportText(report: SavingsReport, width = 120): string {
	return savingsReportLines(report, width)
		.map((line) =>
			line
				.map((segment) => segment.text)
				.join("")
				.trimEnd(),
		)
		.join("\n");
}

/** The short line at the end of a run that saved something: "Token saving: 12.3k tokens ($0.04) saved in this run". */
export function runSavingsLine(saved: { tokens: number; costUsd: number }): string | undefined {
	if (saved.tokens <= 0 && saved.costUsd <= 0) return undefined;
	const parts: string[] = [];
	if (saved.tokens > 0) parts.push(`${formatReportTokens(saved.tokens)} tokens`);
	if (saved.costUsd > 0)
		parts.push(saved.tokens > 0 ? `(${formatReportUsd(saved.costUsd)})` : formatReportUsd(saved.costUsd));
	return `Token saving: ${parts.join(" ")} saved in this run. /savings shows the report.`;
}
