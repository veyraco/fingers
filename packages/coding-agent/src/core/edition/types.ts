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
 */
export const EE_API_VERSION = 2;

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
