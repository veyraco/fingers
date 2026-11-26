/**
 * The contract between the MIT core and Fingers ee (the `ee/` folder of the repository, under the Veyra commercial
 * license in `ee/LICENSE`).
 *
 * The core never imports `ee/`. At startup it looks for a built ee module (loader.ts) and, when one is there, hands it
 * an `EeHost`; the module registers the commands of the features that are on. Which features are on is decided here in
 * the core from three facts (gate.ts): the person is signed in to Veyra, the organization has the `fingers` app on,
 * and the organization's tier includes the feature (the tier matrix comes from the ee module and is versioned there).
 * Without the ee module, or without a sign-in, Fingers is "core only".
 */

import type { ImageContent, TextContent } from "@veyraco/fingers-ai";
import type { SavingsEntry } from "../savings-ledger.ts";

/**
 * Bumped when this contract changes; an ee module built for another version is not loaded.
 * 2: tool hooks (`EeHost.registerToolHooks`) and the savings ledger (`EeHost.recordSaving`), for token saving (F14).
 * 3: context hooks (`EeToolHooks.contextEdits`, `beforeCompact`, `afterCompact`), for saving context (F15).
 */
export const EE_API_VERSION = 3;

/** Connect's tiers (one per organization, for every app), lowest first. */
export const VEYRA_TIERS = ["free", "low", "medium", "high"] as const;
export type VeyraTier = (typeof VEYRA_TIERS)[number];

/** The ee features, as the canvas lists them (FingersTuiLogin "ee features on", FingersTuiLocked). */
export const EE_FEATURE_IDS = ["token_saving", "subagents", "checkpoints", "brain", "eyes", "org_hooks"] as const;
export type EeFeatureId = (typeof EE_FEATURE_IDS)[number];

/** Where the entitlement facts came from. */
export type EeEntitlementSource =
	/** Connect answered just now. */
	| "connect"
	/** Connect could not be reached; the facts Connect gave within the offline grace period. */
	| "cache"
	/** Nothing usable: not signed in, Connect refused, or the cached facts are too old. */
	| "none";

/** What the gate knows about the signed-in organization. No token, nothing secret. */
export interface EeEntitlement {
	signedIn: boolean;
	source: EeEntitlementSource;
	org?: string;
	orgName?: string;
	/** Connect's tier string; an unknown one turns every ee feature off. */
	tier?: string;
	/** The organization has the `fingers` app on (Connect `apps_enabled`). */
	fingersEnabled: boolean;
	/** When Connect last confirmed these facts (epoch ms). */
	checkedAt?: number;
	/** Signed in, but Connect has not confirmed the facts within the offline grace period. */
	offline?: boolean;
	/** Connect refused the organization lookup (HTTP 4xx), e.g. the member was removed. */
	denied?: string;
}

export const SIGNED_OUT: EeEntitlement = Object.freeze({ signedIn: false, source: "none", fingersEnabled: false });

/** Why an ee feature is off, most fundamental first. */
export type EeLockReason =
	/** This build has no ee module (core only), or its contract version differs. */
	| "no_ee"
	/** Not signed in to Veyra. */
	| "signed_out"
	/** Signed in, but Connect has not confirmed the tier for longer than the offline grace period. */
	| "offline"
	/** Connect refused the organization lookup. */
	| "denied"
	/** The organization does not have the `fingers` app on. */
	| "fingers_off"
	/** Connect sent a tier this Fingers does not know. */
	| "unknown_tier"
	/** The organization's tier is below the feature's minimum tier. */
	| "tier";

export type EeFeatureState = { on: true } | { on: false; reason: EeLockReason; needs?: VeyraTier };

/** What an ee command handler may do in the terminal app. */
export interface EeCommandContext {
	/** The text after the command name, trimmed. */
	args: string;
	entitlement: EeEntitlement;
	showStatus(message: string): void;
	showWarning(message: string): void;
}

export type EeCommandHandler = (context: EeCommandContext) => void | Promise<void>;

/**
 * A tool result before the model sees it, as an ee tool hook gets it. Only results of the terminal app's own session
 * reach the hooks (managed RPC, print and JSON modes keep ee off).
 */
export interface EeToolResult {
	toolName: string;
	toolCallId: string;
	/**
	 * Another tool (such as a codemode script) made this call: the result goes to that tool, not to the model, so a
	 * hook must leave it as it is.
	 */
	nested: boolean;
	input: Record<string, unknown>;
	content: (TextContent | ImageContent)[];
	/** The tool's details, e.g. bash's `fullOutputPath` when the core already cut the output. */
	details?: unknown;
	isError: boolean;
	/** The session's working directory. */
	cwd: string;
	/** For read, edit and write: the absolute path of the file, resolved as the tool resolved it. */
	path?: string;
}

/** A hook's replacement for the content the model gets. */
export interface EeToolResultChange {
	content: (TextContent | ImageContent)[];
}

/**
 * One model-visible entry of the conversation since the latest compaction, as a context hook sees it (F15). Only
 * tool results carry their content: the other entries are there for their position and size.
 */
export interface EeContextEntry {
	/** The session entry id: the target of a context edit. */
	id: string;
	role: "user" | "assistant" | "toolResult" | "custom" | "summary" | "other";
	/** Estimated tokens of what the model gets from this entry now (chars/4, like compaction). */
	tokens: number;
	/** An earlier context edit already replaced this entry's content. */
	edited: boolean;
	/** Tool results only. */
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	/** Tool results only: the arguments of the tool call, from the assistant message that made it. */
	input?: Record<string, unknown>;
	/** Tool results of read, edit and write: the absolute path, resolved as the tool resolved it. */
	path?: string;
	/** Tool results only: the content the model gets now. */
	content?: (TextContent | ImageContent)[];
}

/** The model's context at the end of a turn, for `EeToolHooks.contextEdits`. */
export interface EeContextView {
	/** In order, oldest first. */
	entries: readonly EeContextEntry[];
	/** Estimated tokens of the whole context now (the session's own estimate, as compaction uses it). */
	tokens: number;
	/** The model's context window, in tokens. */
	contextWindow: number;
	/** The session's compaction settings: core compaction starts above contextWindow - reserveTokens. */
	compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
	cwd: string;
}

/** A replacement for the content of one earlier tool result, saved in the session as a context edit. */
export interface EeContextEdit {
	targetId: string;
	content: (TextContent | ImageContent)[];
}

/** What a compaction is about to summarise, for `EeToolHooks.beforeCompact`. All sizes are chars/4 estimates. */
export interface EeCompactionPreview {
	reason: "manual" | "threshold" | "overflow";
	/** The context before compaction, measured the way `EeCompactionOutcome.tokensAfter` is. */
	tokensBefore: number;
	/** The messages the summary replaces (with a split turn, both parts). */
	summarizedTokens: number;
	/** The previous compaction's summary, which the new summary replaces; 0 for the first compaction. */
	previousSummaryTokens: number;
	/** The read and modified file lists the core appends to every summary. */
	fileListTokens: number;
	/** The cut falls inside a turn: two summaries are made. */
	splitTurn: boolean;
	/** The most the summary call may write (compaction asks for at most 80% of reserveTokens). */
	summaryMaxTokens: number;
}

/** What a compaction measured, for `EeToolHooks.afterCompact`. */
export interface EeCompactionOutcome {
	reason: "manual" | "threshold" | "overflow";
	tokensBefore: number;
	/** The context after compaction, measured like `tokensBefore`. */
	tokensAfter: number;
	/** The new summary, including the file lists. */
	summaryTokens: number;
}

/** What an ee feature adds to the session while it is on. */
export interface EeToolHooks {
	/** Change a tool result before the model sees it; undefined leaves it as it is. Hooks run in registration order. */
	toolResult?(result: EeToolResult): EeToolResultChange | undefined | Promise<EeToolResultChange | undefined>;
	/** Lines added to a tool's guidelines in the system prompt (by tool name) while the feature is on. */
	toolGuidelines?(): Readonly<Record<string, readonly string[]>>;
	/**
	 * The model's context was rebuilt or replaced (a new, resumed or forked session, a reload, compaction, a move in
	 * the session tree): forget anything that assumed an earlier tool result is still in it.
	 */
	contextReset?(): void;
	/**
	 * At the end of each turn (after the tool results were saved, before the next model call): replacements for the
	 * content of earlier tool results, saved as context edits, so every later request and compaction gets the
	 * replacement. Only entries of `view` that are tool results may be targets. Hooks run in registration order, each
	 * on the view the one before left.
	 */
	contextEdits?(view: EeContextView): readonly EeContextEdit[] | undefined;
	/** A compaction is about to run: a line to show while it runs (e.g. its saving estimate), or undefined. */
	beforeCompact?(preview: EeCompactionPreview): string | undefined;
	/** A compaction finished: a line to show under its summary, or undefined. */
	afterCompact?(outcome: EeCompactionOutcome): string | undefined;
}

/** What the core hands the ee module when it activates it. */
export interface EeHost {
	readonly apiVersion: number;
	readonly entitlement: EeEntitlement;
	/** Whether a feature is on right now (signed in, Fingers on for the org, tier includes it). */
	isOn(feature: EeFeatureId): boolean;
	/** Register the handler of a built-in ee slash command (e.g. "agents"). Only a feature that is on may register. */
	registerCommand(name: string, handler: EeCommandHandler): void;
	/**
	 * Register the tool hooks of a feature. Only a feature that is on may register, and the core checks again on every
	 * call, so the hooks stop the moment the feature goes off (sign-out, tier change, Fingers turned off).
	 */
	registerToolHooks(feature: EeFeatureId, hooks: EeToolHooks): void;
	/** Write what a token-saving technique saved to the session's savings ledger. */
	recordSaving(entry: SavingsEntry): void;
}

/** What `ee/` exports (its default export or the module namespace). */
export interface EeModule {
	/** Must equal EE_API_VERSION. */
	apiVersion: number;
	/** The tier matrix' version, e.g. "2026-11-22.1". */
	matrixVersion: string;
	/** The lowest tier that includes `feature`, or undefined when no tier does. */
	minimumTier(feature: EeFeatureId): VeyraTier | undefined;
	/** Called each time the entitlement changes; registers the commands of the features that are on. */
	activate(host: EeHost): void;
}

export function isVeyraTier(value: unknown): value is VeyraTier {
	return typeof value === "string" && (VEYRA_TIERS as readonly string[]).includes(value);
}

/** True when `tier` is `minimum` or higher. */
export function tierIncludes(tier: VeyraTier, minimum: VeyraTier): boolean {
	return VEYRA_TIERS.indexOf(tier) >= VEYRA_TIERS.indexOf(minimum);
}
