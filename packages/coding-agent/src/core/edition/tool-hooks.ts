/**
 * The ee tool hooks that are live in this process: the gate fills this after each activation of the ee module with
 * the hooks of the features that are on, and the built-in `edition` extension (src/extensions/edition) calls them on
 * every tool result, at the end of every turn (context edits) and around compactions. Each call checks the feature
 * again, so a hook stops the moment its feature goes off.
 *
 * Only the terminal app's gate fills it; managed RPC, print and JSON modes never do, so there the extension changes
 * nothing.
 */
import { estimateTextTokens, SavingsLedger } from "../savings-ledger.ts";
import type {
	EeCompactionOutcome,
	EeCompactionPreview,
	EeContextEdit,
	EeContextEntry,
	EeContextView,
	EeFeatureId,
	EeRouteChoice,
	EeRouteOutcome,
	EeRouteRequest,
	EeToolHooks,
	EeToolResult,
	EeToolResultChange,
} from "./types.ts";

interface RegisteredHooks {
	feature: EeFeatureId;
	hooks: EeToolHooks;
}

function isContentBlock(block: unknown): block is EeContextEdit["content"][number] {
	if (!block || typeof block !== "object") return false;
	const candidate = block as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
	if (candidate.type === "text") return typeof candidate.text === "string";
	if (candidate.type === "image") return typeof candidate.data === "string" && typeof candidate.mimeType === "string";
	return false;
}

/** chars/4 of a content, with an image counted like compaction counts it. */
function contentTokens(content: EeContextEdit["content"]): number {
	let tokens = 0;
	for (const block of content) tokens += block.type === "text" ? estimateTextTokens(block.text) : 1200;
	return tokens;
}

export class EditionToolHooks {
	private registered: RegisteredHooks[] = [];
	private isOn: (feature: EeFeatureId) => boolean = () => false;
	private readonly onError: (error: unknown) => void;
	private readonly listeners = new Set<() => void>();
	private notices: string[] = [];

	constructor(options: { onError?: (error: unknown) => void } = {}) {
		this.onError = options.onError ?? (() => {});
	}

	/** Use these hooks from now on; `isOn` is asked again before every call. */
	set(registered: readonly RegisteredHooks[], isOn: (feature: EeFeatureId) => boolean): void {
		this.registered = [...registered];
		this.isOn = isOn;
		this.changed();
	}

	/** No hooks: core only. */
	clear(): void {
		this.registered = [];
		this.isOn = () => false;
		this.changed();
	}

	/** Called after every set() and clear(). Returns the unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Some registered hook (on or off right now) wants to edit the context at the end of a turn. */
	get hasContextHooks(): boolean {
		return this.registered.some(({ hooks }) => typeof hooks.contextEdits === "function");
	}

	/** At least one hook of a feature that is on. */
	get active(): boolean {
		return this.live().length > 0;
	}

	/**
	 * Run the toolResult hooks in order, each on the content the one before returned. A hook that throws is skipped,
	 * so ee never breaks a tool call. Undefined when nothing changed.
	 */
	async toolResult(result: EeToolResult): Promise<EeToolResultChange | undefined> {
		let content = result.content;
		let changed = false;
		for (const { hooks } of this.live()) {
			if (!hooks.toolResult) continue;
			try {
				const change = await hooks.toolResult({ ...result, content });
				if (change && Array.isArray(change.content)) {
					content = change.content;
					changed = true;
				}
			} catch (error) {
				this.onError(error);
			}
		}
		return changed ? { content } : undefined;
	}

	/** Tool guideline lines of the features that are on, by tool name. */
	toolGuidelines(): Record<string, string[]> {
		const guidelines: Record<string, string[]> = {};
		for (const { hooks } of this.live()) {
			if (!hooks.toolGuidelines) continue;
			try {
				for (const [tool, lines] of Object.entries(hooks.toolGuidelines())) {
					for (const line of lines) {
						if (typeof line !== "string" || line.length === 0) continue;
						const forTool = guidelines[tool] ?? [];
						forTool.push(line);
						guidelines[tool] = forTool;
					}
				}
			} catch (error) {
				this.onError(error);
			}
		}
		return guidelines;
	}

	/**
	 * Run the contextEdits hooks in order, each on the view with the edits of the ones before applied. An edit is kept
	 * only when it targets a tool result of the view that no earlier edit of this call targeted and its content is
	 * text or image blocks. A hook that throws is skipped.
	 */
	contextEdits(view: EeContextView): EeContextEdit[] {
		const edits: EeContextEdit[] = [];
		let entries: EeContextEntry[] = [...view.entries];
		for (const { hooks } of this.live()) {
			if (!hooks.contextEdits) continue;
			let proposed: readonly EeContextEdit[] | undefined;
			try {
				proposed = hooks.contextEdits({ ...view, entries });
			} catch (error) {
				this.onError(error);
				continue;
			}
			if (!Array.isArray(proposed)) continue;
			for (const edit of proposed) {
				if (!edit || typeof edit.targetId !== "string" || !Array.isArray(edit.content)) continue;
				if (!edit.content.every(isContentBlock)) continue;
				if (edits.some((earlier) => earlier.targetId === edit.targetId)) continue;
				const index = entries.findIndex((entry) => entry.id === edit.targetId);
				const target = entries[index];
				if (!target || target.role !== "toolResult") continue;
				const content: EeContextEdit["content"] = (edit.content as EeContextEdit["content"]).map((block) => ({
					...block,
				}));
				edits.push({ targetId: edit.targetId, content });
				entries = entries.map((entry, i) =>
					i === index ? { ...entry, content, tokens: contentTokens(content), edited: true } : entry,
				);
			}
		}
		return edits;
	}

	/**
	 * Ask the routing hooks for a cheaper model for a sub-task. The first hook whose answer names one of the request's
	 * candidates decides; an answer that names anything else is ignored, so a hook can never route to a model the core
	 * did not offer. A hook that throws is skipped. Undefined: keep the current model.
	 */
	routeModel(request: EeRouteRequest): EeRouteChoice | undefined {
		for (const { hooks } of this.live()) {
			if (!hooks.routeModel) continue;
			let choice: EeRouteChoice | undefined;
			try {
				choice = hooks.routeModel(request);
			} catch (error) {
				this.onError(error);
				continue;
			}
			if (!choice || typeof choice.provider !== "string" || typeof choice.id !== "string") continue;
			const candidate = request.candidates.find(
				(model) => model.provider === choice.provider && model.id === choice.id,
			);
			if (candidate) return { provider: candidate.provider, id: candidate.id };
		}
		return undefined;
	}

	/** The lines the hooks want shown after a routed sub-task. */
	afterRoute(outcome: EeRouteOutcome): string[] {
		return this.lines((hooks) => hooks.afterRoute?.(outcome));
	}

	/** The lines the hooks want shown while a compaction runs. */
	beforeCompact(preview: EeCompactionPreview): string[] {
		return this.lines((hooks) => hooks.beforeCompact?.(preview));
	}

	/** The lines the hooks want shown under a finished compaction. */
	afterCompact(outcome: EeCompactionOutcome): string[] {
		return this.lines((hooks) => hooks.afterCompact?.(outcome));
	}

	/**
	 * Keep lines for the terminal app to show once it has redrawn the chat (it redraws the whole chat after a
	 * compaction, which would wipe a line shown before).
	 */
	addNotices(lines: readonly string[]): void {
		this.notices.push(...lines);
	}

	/** The kept lines, once. */
	takeNotices(): string[] {
		const notices = this.notices;
		this.notices = [];
		return notices;
	}

	/** Tell every registered hook, on or off, that the model's context was rebuilt. */
	contextReset(): void {
		for (const { hooks } of this.registered) {
			try {
				hooks.contextReset?.();
			} catch (error) {
				this.onError(error);
			}
		}
	}

	private lines(call: (hooks: EeToolHooks) => string | undefined): string[] {
		const lines: string[] = [];
		for (const { hooks } of this.live()) {
			try {
				const line = call(hooks);
				if (typeof line === "string" && line.length > 0) lines.push(line);
			} catch (error) {
				this.onError(error);
			}
		}
		return lines;
	}

	private changed(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch (error) {
				this.onError(error);
			}
		}
	}

	private live(): RegisteredHooks[] {
		return this.registered.filter(({ feature }) => {
			try {
				return this.isOn(feature);
			} catch {
				return false;
			}
		});
	}
}

/** This process' ee tool hooks (filled by the terminal app's gate). */
export const editionToolHooks = new EditionToolHooks();

/** This process' savings ledger: what token saving saved in the current conversation. */
export const savingsLedger = new SavingsLedger();
