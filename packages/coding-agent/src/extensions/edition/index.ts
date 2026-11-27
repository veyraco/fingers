/**
 * Open core: the built-in extension through which ee features act on a session (token saving, saving
 * context, and later ee features). It is MIT and holds no ee logic: it passes each tool result to the ee tool hooks
 * of the features that are on (core/edition/tool-hooks.ts), adds their tool guidelines to the system prompt, tells
 * them when the model's context was rebuilt, saves the context edits they ask for at the end of a turn, and shows
 * their lines around a compaction. With no hooks (core only, signed out, a tier without the feature, managed RPC,
 * print and JSON modes) it changes nothing, and it listens to turn ends only while some hook edits the context.
 *
 * It also keeps the conversation's savings ledger: it prices each saving at the list price of the model in use,
 * writes new savings to the session file as custom entries when a run settles (and before the session is left), reads
 * them back when a conversation is opened or the tree is navigated, and says what a run saved when it ends.
 */

import type { AgentMessage } from "@veyraco/fingers-agent";
import type { Model } from "@veyraco/fingers-ai";
import { isListPriced } from "../../core/budget.ts";
import {
	type CompactionPreparation,
	computeFileLists,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	formatFileOperations,
} from "../../core/compaction/index.ts";
import { type EditionToolHooks, editionToolHooks, savingsLedger } from "../../core/edition/tool-hooks.ts";
import type { EeCompactionPreview, EeContextEntry, EeContextView, EeToolResult } from "../../core/edition/types.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	TurnEndEvent,
	TurnEndEventResult,
} from "../../core/extensions/types.ts";
import {
	parseSavingsRecord,
	SAVINGS_ENTRY_TYPE,
	type SavingsLedger,
	type SavingsPricing,
	type SavingsRecord,
} from "../../core/savings-ledger.ts";
import { runSavingsLine } from "../../core/savings-report.ts";
import { buildSessionProjection, type ProjectedSessionEntry, type SessionEntry } from "../../core/session-manager.ts";
import { resolveReadPathAsync, resolveToCwd } from "../../core/tools/path-utils.ts";

interface EditionExtensionOptions {
	/** Default: this process' hooks, which the terminal app's gate fills. */
	hooks?: EditionToolHooks;
	/** Default: this process' savings ledger. */
	savings?: SavingsLedger;
}

/** The file a read, edit or write call names, resolved as that tool resolves it. */
async function toolPath(toolName: string, input: Record<string, unknown>, cwd: string): Promise<string | undefined> {
	const path = input.path;
	if (typeof path !== "string" || path.length === 0) return undefined;
	try {
		if (toolName === "read") return await resolveReadPathAsync(path, cwd);
		if (toolName === "edit" || toolName === "write") return resolveToCwd(path, cwd);
	} catch {
		return undefined;
	}
	return undefined;
}

type CompactionSettings = EeContextView["compaction"];

function tokenSetting(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** The session's compaction settings for `model`, resolved like the settings manager resolves them. */
function compactionSettings(fingers: ExtensionAPI, model: Model<string> | undefined): CompactionSettings {
	let compaction: Record<string, unknown> | undefined;
	try {
		const value = (fingers.getSettings() as { compaction?: unknown }).compaction;
		if (value && typeof value === "object" && !Array.isArray(value)) compaction = value as Record<string, unknown>;
	} catch {
		compaction = undefined;
	}
	const overrides = compaction?.modelOverrides;
	const override =
		model && overrides && typeof overrides === "object"
			? ((overrides as Record<string, unknown>)[`${model.provider}/${model.id}`] as
					| Record<string, unknown>
					| undefined)
			: undefined;
	const field = (name: "reserveTokens" | "keepRecentTokens") =>
		tokenSetting(override?.[name]) ?? tokenSetting(compaction?.[name]) ?? DEFAULT_COMPACTION_SETTINGS[name];
	return {
		enabled: typeof compaction?.enabled === "boolean" ? compaction.enabled : DEFAULT_COMPACTION_SETTINGS.enabled,
		reserveTokens: field("reserveTokens"),
		keepRecentTokens: field("keepRecentTokens"),
	};
}

/** chars/4 of everything the model gets, as the session estimates a context after compaction. */
function measure(messages: readonly AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) tokens += estimateTokens(message);
	return tokens;
}

function contextRole(message: AgentMessage): EeContextEntry["role"] | undefined {
	switch (message.role) {
		case "system":
			return undefined;
		case "user":
		case "assistant":
		case "toolResult":
		case "custom":
			return message.role;
		case "compactionSummary":
		case "branchSummary":
			return "summary";
		default:
			return "other";
	}
}

/** The conversation since the latest compaction as context hooks see it: one entry per model-visible entry. */
async function contextEntries(
	entries: readonly ProjectedSessionEntry[],
	cwd: string,
	paths: Map<string, string | undefined>,
): Promise<EeContextEntry[]> {
	const edited = new Set<string>();
	const calls = new Map<string, Record<string, unknown>>();
	for (const { sourceEntry, messages } of entries) {
		if (sourceEntry.type === "context_edit") edited.add(sourceEntry.targetId);
		for (const message of messages) {
			if (message.role !== "assistant") continue;
			for (const block of message.content) {
				if (block.type === "toolCall") calls.set(block.id, (block.arguments ?? {}) as Record<string, unknown>);
			}
		}
	}
	const view: EeContextEntry[] = [];
	for (const { sourceEntry, messages } of entries) {
		const first = messages[0];
		if (!first || sourceEntry.type === "context_edit") continue;
		const role = contextRole(first);
		if (!role) continue;
		const entry: EeContextEntry = {
			id: sourceEntry.id,
			role,
			tokens: messages.reduce((sum, message) => sum + estimateTokens(message), 0),
			edited: edited.has(sourceEntry.id),
		};
		if (first.role === "toolResult" && messages.length === 1) {
			entry.toolName = first.toolName;
			entry.toolCallId = first.toolCallId;
			entry.isError = first.isError;
			entry.content = first.content.map((block) => ({ ...block }));
			const input = calls.get(first.toolCallId);
			if (input) {
				entry.input = input;
				// Resolved once per tool call (a read's path resolution touches the file system).
				if (!paths.has(first.toolCallId)) paths.set(first.toolCallId, await toolPath(first.toolName, input, cwd));
				const path = paths.get(first.toolCallId);
				if (path) entry.path = path;
			}
		}
		view.push(entry);
	}
	return view;
}

function compactionPreview(
	preparation: CompactionPreparation,
	branchEntries: Parameters<typeof buildSessionProjection>[0],
	reason: EeCompactionPreview["reason"],
): EeCompactionPreview {
	const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
	return {
		reason,
		tokensBefore: measure(buildSessionProjection(branchEntries).messages),
		summarizedTokens: measure([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]),
		previousSummaryTokens: preparation.previousSummary ? Math.ceil(preparation.previousSummary.length / 4) : 0,
		fileListTokens: Math.ceil(formatFileOperations(readFiles, modifiedFiles).length / 4),
		splitTurn: preparation.isSplitTurn,
		summaryMaxTokens: Math.floor(0.8 * preparation.settings.reserveTokens),
	};
}

/** The list price of `model`, or undefined for an unpriced one (local, virtual): its savings stay in tokens. */
export function savingsPricing(model: Model<string> | undefined): SavingsPricing | undefined {
	if (!model || !isListPriced(model)) return undefined;
	return {
		provider: model.provider,
		model: model.id,
		inputPerMTok: model.cost.input ?? 0,
		outputPerMTok: model.cost.output ?? 0,
	};
}

/** The savings the session file holds on this branch, oldest first. */
export function savingsOnBranch(entries: readonly SessionEntry[]): SavingsRecord[] {
	const records: SavingsRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SAVINGS_ENTRY_TYPE) continue;
		const record = parseSavingsRecord(entry.data);
		if (record) records.push(record);
	}
	return records;
}

export function createEditionExtension(options: EditionExtensionOptions = {}): ExtensionFactory {
	const hooks = options.hooks ?? editionToolHooks;
	const savings = options.savings ?? savingsLedger;
	return (fingers) => {
		fingers.on("tool_result", async (event, ctx) => {
			if (!hooks.active) return undefined;
			const result: EeToolResult = {
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				nested: event.parentToolCallId !== undefined,
				input: event.input,
				content: event.content,
				details: event.details,
				isError: event.isError,
				cwd: ctx.cwd,
			};
			const path = await toolPath(event.toolName, event.input, ctx.cwd);
			if (path) result.path = path;
			const change = await hooks.toolResult(result);
			// The structured result belongs to the content the tool made; a replaced content drops it (programmatic
			// callers never get a changed result: hooks leave nested calls alone).
			return change ? { content: change.content } : undefined;
		});

		fingers.on("before_agent_start", (event) => {
			if (!hooks.active) return undefined;
			const toolGuidelines = event.systemPromptOptions.toolGuidelines;
			for (const [tool, lines] of Object.entries(hooks.toolGuidelines())) {
				if (!event.systemPromptOptions.selectedTools.includes(tool)) continue;
				const existing = toolGuidelines[tool] ?? [];
				for (const line of lines) if (!existing.includes(line)) existing.push(line);
				toolGuidelines[tool] = existing;
			}
			return undefined;
		});

		const toolPaths = new Map<string, string | undefined>();
		// Turn ends cost the session a preview of the whole branch, so listen only while some hook edits the context.
		const onTurnEnd = async (event: TurnEndEvent, ctx: ExtensionContext): Promise<TurnEndEventResult | undefined> => {
			if (!hooks.active) return undefined;
			const model = ctx.model as Model<string> | undefined;
			const usage = ctx.getContextUsage();
			const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
			if (contextWindow <= 0) return undefined;
			const entries = await contextEntries(event.context.contextEntries, ctx.cwd, toolPaths);
			const view: EeContextView = {
				entries,
				tokens: usage?.tokens ?? measure(event.context.contextMessages),
				contextWindow,
				compaction: compactionSettings(fingers, model),
				cwd: ctx.cwd,
			};
			const edits = hooks.contextEdits(view);
			if (edits.length === 0) return undefined;
			return {
				entries: [
					...event.entries,
					...edits.map((edit) => ({
						type: "context_edit" as const,
						targetId: edit.targetId,
						replacement: { content: edit.content },
					})),
				],
			};
		};
		let stopTurnEnd: (() => void) | undefined;
		const syncTurnEnd = () => {
			if (hooks.hasContextHooks && !stopTurnEnd) stopTurnEnd = fingers.on("turn_end", onTurnEnd);
			else if (!hooks.hasContextHooks && stopTurnEnd) {
				stopTurnEnd();
				stopTurnEnd = undefined;
			}
		};
		syncTurnEnd();
		const stopSync = hooks.onChange(syncTurnEnd);
		fingers.on("session_shutdown", () => {
			stopSync();
			stopTurnEnd?.();
			stopTurnEnd = undefined;
		});

		let compacting: EeCompactionPreview | undefined;
		fingers.on("session_before_compact", (event, ctx) => {
			compacting = undefined;
			if (!hooks.active) return undefined;
			compacting = compactionPreview(event.preparation, event.branchEntries, event.reason);
			if (ctx.hasUI) for (const line of hooks.beforeCompact(compacting)) ctx.ui.notify(line, "info");
			return undefined;
		});
		fingers.on("session_compact", (event, ctx) => {
			hooks.contextReset();
			const preview = compacting;
			compacting = undefined;
			if (!preview || !hooks.active) return;
			const lines = hooks.afterCompact({
				reason: event.reason,
				tokensBefore: preview.tokensBefore,
				tokensAfter: measure(ctx.sessionManager.buildSessionProjection().messages),
				summaryTokens: Math.ceil(event.compactionEntry.summary.length / 4),
			});
			// The terminal app redraws the chat after a compaction; it shows these lines after that.
			if (ctx.hasUI && ctx.mode === "tui") hooks.addNotices(lines);
		});
		fingers.on("session_compact_failed", () => {
			compacting = undefined;
		});

		// The savings ledger belongs to the conversation: priced at the model in use, kept in the session file.
		let model: Model<string> | undefined;
		const track = (ctx: ExtensionContext) => {
			model = ctx.model as Model<string> | undefined;
		};
		const stopPricing = savings.setPricing(() => savingsPricing(model));
		let unsaved: SavingsRecord[] = [];
		const stopRecord = savings.onRecord((record) => unsaved.push(record));
		const persist = () => {
			const pending = unsaved;
			unsaved = [];
			for (const record of pending) {
				try {
					fingers.appendEntry(SAVINGS_ENTRY_TYPE, record);
				} catch {
					// The session is gone (shut down): the saving stays in this process' ledger only.
				}
			}
		};
		const reload = (ctx: ExtensionContext) => {
			unsaved = [];
			savings.load(savingsOnBranch(ctx.sessionManager.getBranch()));
		};
		let runStart = 0;

		fingers.on("session_start", (_event, ctx) => {
			hooks.contextReset();
			toolPaths.clear();
			track(ctx);
			// The conversation's own savings: none for a new one, the saved ones for a resumed, forked or reloaded one.
			reload(ctx);
		});
		fingers.on("session_tree", (_event, ctx) => {
			hooks.contextReset();
			// Another branch of the conversation: its savings.
			reload(ctx);
		});
		fingers.on("session_before_tree", () => persist());
		fingers.on("model_select", (event) => {
			model = event.model as Model<string>;
		});
		fingers.on("turn_start", (_event, ctx) => track(ctx));
		fingers.on("agent_start", (_event, ctx) => {
			track(ctx);
			runStart = savings.size;
		});
		fingers.on("agent_settled", (_event, ctx) => {
			const added = savings.entries().slice(runStart);
			runStart = savings.size;
			persist();
			const line = runSavingsLine({
				tokens: added.reduce((sum, record) => sum + record.tokens, 0),
				costUsd: added.reduce((sum, record) => sum + (record.costUsd ?? 0), 0),
			});
			if (line && ctx.hasUI && ctx.mode === "tui") ctx.ui.notify(line, "info");
		});
		fingers.on("session_compact", () => persist());
		fingers.on("session_shutdown", () => {
			// Written to the conversation being left, before the next one is opened.
			persist();
			stopRecord();
			stopPricing();
		});
	};
}

export default createEditionExtension();
