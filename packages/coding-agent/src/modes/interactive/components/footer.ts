import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@veyraco/fingers-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ContextUsage } from "../../../core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { addUsageToTotals, createUsageTotals, formatCacheHit, type UsageTotals } from "../../../core/usage-totals.ts";
import { theme } from "../theme/theme.ts";
import { editorHintLine } from "./keybinding-hints.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/** Token counts as on the canvas status line: 950, 2.1k, 18.4k, 412.0k, 1.21M. */
export function formatTokenCount(count: number): string {
	if (count < 1000) return Math.round(count).toString();
	if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(2)}M`;
}

/** Dollar amounts on the status line: two decimals, three below one cent so small spends are not $0.00. */
export function formatCost(usd: number): string {
	return usd > 0 && usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

/** The Veyra account as the status line shows it. Filled by `fingers login` and the ee gate. */
export interface FingersAccountStatus {
	signedIn: boolean;
	email?: string;
	/** ee features are on for this account's organization tier. */
	eeOn?: boolean;
	org?: string;
}

/** Status the shell shows besides the session's own numbers. Every getter is optional. */
export interface FingersShellStatus {
	/** Undefined or `signedIn: false`: "core only · not signed in". */
	getAccount?(): FingersAccountStatus | undefined;
	/** The task budget, when one is set. */
	getBudget?(): { spentUsd: number; capUsd: number } | undefined;
	/** The memory provider's label, e.g. `Brain "acme-web"`. */
	getMemory?(): string | undefined;
}

interface SessionStats {
	session: AgentSession;
	sessionId: string;
	leafId: string | null;
	entryCount: number;
	limitsModel: unknown;
	usageTotals: UsageTotals;
	contextUsage: ContextUsage | undefined;
}

/**
 * Footer component: the location line (cwd, branch, session, org, memory) and the status line.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private sessionStats?: SessionStats;
	private shell: FingersShellStatus | undefined;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider, shell?: FingersShellStatus) {
		this.session = session;
		this.footerData = footerData;
		this.shell = shell;
	}

	setShellStatus(shell: FingersShellStatus | undefined): void {
		this.shell = shell;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	/**
	 * Usage totals and context usage scan the whole session, and the footer renders on every frame.
	 * Entries are append-only and every append moves the leaf, so the results only change with the
	 * session, leaf, entry count, or the model whose context window applies.
	 */
	private getSessionStats(): SessionStats {
		const sessionManager = this.session.sessionManager;
		const entryCount = sessionManager.getEntryCount();
		const sessionId = sessionManager.getSessionId();
		const leafId = sessionManager.getLeafId();
		const limitsModel = this.session.routedModel?.model ?? this.session.model;
		const cached = this.sessionStats;
		if (
			cached &&
			cached.session === this.session &&
			cached.sessionId === sessionId &&
			cached.leafId === leafId &&
			cached.entryCount === entryCount &&
			cached.limitsModel === limitsModel
		) {
			return cached;
		}

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		const usageTotals = createUsageTotals();

		for (const entry of sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		this.sessionStats = {
			session: this.session,
			sessionId,
			leafId,
			entryCount,
			limitsModel,
			usageTotals,
			contextUsage,
		};
		return this.sessionStats;
	}

	render(width: number): string[] {
		const lines = [
			truncateToWidth(theme.fg("dim", `  ${editorHintLine()}`), width, ""),
			this.renderLocationLine(width),
			this.renderStatusBar(width),
		];

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}

	/** `~/acme/web  ·  main  ·  session name  ·  org …  ·  memory: …` (canvas FingersTuiSession, first line). */
	private renderLocationLine(width: number): string {
		const separator = theme.fg("dim", "  ·  ");
		const home = process.env.HOME || process.env.USERPROFILE;
		const parts = [theme.fg("accent", formatCwdForFooter(this.session.sessionManager.getCwd(), home))];
		const branch = this.footerData.getGitBranch();
		if (branch) parts.push(theme.fg("success", branch));
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) parts.push(theme.fg("muted", sanitizeStatusText(sessionName)));
		const account = this.shell?.getAccount?.();
		if (account?.org) parts.push(theme.fg("muted", `org ${account.org}`));
		const memory = this.shell?.getMemory?.();
		if (memory) parts.push(theme.fg("muted", `memory: ${memory}`));
		return truncateToWidth(parts.join(separator), width, theme.fg("dim", "..."));
	}

	/**
	 * The status line (canvas FingersTui): model, provider, tokens, cost, cache, budget, then the Veyra
	 * account and ee state, on the status bar background across the full width.
	 */
	private renderStatusBar(width: number): string {
		const state = this.session.state;
		const { usageTotals, contextUsage } = this.getSessionStats();
		const bar = theme.fg("dim", "│");
		const segments: string[] = [];

		// Without any configured model the session holds an "unknown" placeholder.
		const hasModel = !!state.model && !(state.model.id === "unknown" && state.model.provider === "unknown");
		let model = hasModel ? state.model!.id : "no model";
		if (state.model?.reasoning && state.thinkingLevel && state.thinkingLevel !== "off") {
			model += ` · ${state.thinkingLevel}`;
		}
		// A virtual model routes each request; show where the latest response went.
		const routed = this.session.routedModel;
		if (routed) model += ` → ${routed.model.id}${routed.thinkingLevel ? ` · ${routed.thinkingLevel}` : ""}`;
		const modelHead = theme.bold(theme.fg("accent", ` ${model} `));
		const provider = hasModel ? theme.fg("muted", ` ${state.model!.provider} `) : "";
		segments.push(modelHead + provider);

		const promptTokens = usageTotals.input + usageTotals.cacheRead + usageTotals.cacheWrite;
		segments.push(
			theme.fg("text", ` ${formatTokenCount(promptTokens)} in · ${formatTokenCount(usageTotals.output)} out `),
		);

		// Kimi Coding is subscription-backed despite using API-key authentication.
		const usingSubscription = state.model
			? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingSubscription(state.model.provider)
			: false;
		segments.push(theme.fg("text", ` ${formatCost(usageTotals.cost)}${usingSubscription ? " (sub)" : ""} `));

		const cacheHit = formatCacheHit(usageTotals);
		if (cacheHit) segments.push(theme.fg("success", ` ${cacheHit} `));

		const budget = this.shell?.getBudget?.();
		let budgetIndex = -1;
		if (budget) {
			const left = Math.max(0, budget.capUsd - budget.spentUsd);
			budgetIndex = segments.length;
			segments.push(theme.fg("warning", ` budget ${formatCost(left)} left of ${formatCost(budget.capUsd)} `));
		}

		// The context window only shows once it fills up: compaction is near.
		const contextPercent = contextUsage?.percent;
		if (typeof contextPercent === "number" && contextPercent > 70) {
			const color = contextPercent > 90 ? "error" : "warning";
			const auto = this.autoCompactEnabled ? " (auto)" : "";
			segments.push(theme.fg(color, ` context ${Math.floor(contextPercent)}%${auto} `));
		}
		if (areExperimentalFeaturesEnabled()) segments.push(theme.bold(theme.fg("warning", " xp ")));

		const account = this.shell?.getAccount?.();
		segments.push(
			account?.signedIn
				? theme.fg("accent", ` ${account.eeOn ? "ee on" : "core only"} · ${account.email ?? "signed in"} `)
				: theme.fg("muted", " core only · not signed in "),
		);

		// Too wide: drop the provider name, then shorten the budget, then truncate.
		let joined = segments.join(bar);
		if (visibleWidth(joined) > width && provider) {
			segments[0] = modelHead;
			joined = segments.join(bar);
		}
		if (visibleWidth(joined) > width && budget && budgetIndex >= 0) {
			const left = Math.max(0, budget.capUsd - budget.spentUsd);
			segments[budgetIndex] = theme.fg("warning", ` budget ${formatCost(left)}/${formatCost(budget.capUsd)} `);
			joined = segments.join(bar);
		}
		const line = truncateToWidth(joined, width, theme.fg("dim", "…"));
		const fill = " ".repeat(Math.max(0, width - visibleWidth(line)));
		// Truncation may end in a full reset; the fill re-applies the bar background after it.
		return theme.bg("statusBarBg", `${line}${theme.getBgAnsi("statusBarBg")}${fill}`);
	}
}
