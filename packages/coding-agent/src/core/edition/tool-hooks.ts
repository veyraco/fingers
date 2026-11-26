/**
 * The ee tool hooks that are live in this process: the gate fills this after each activation of the ee module with
 * the hooks of the features that are on, and the built-in `edition` extension (src/extensions/edition) calls them on
 * every tool result. Each call checks the feature again, so a hook stops the moment its feature goes off.
 *
 * Only the terminal app's gate fills it; managed RPC, print and JSON modes never do, so there the extension changes
 * nothing.
 */
import { SavingsLedger } from "../savings-ledger.ts";
import type { EeFeatureId, EeToolHooks, EeToolResult, EeToolResultChange } from "./types.ts";

interface RegisteredHooks {
	feature: EeFeatureId;
	hooks: EeToolHooks;
}

export class EditionToolHooks {
	private registered: RegisteredHooks[] = [];
	private isOn: (feature: EeFeatureId) => boolean = () => false;
	private readonly onError: (error: unknown) => void;

	constructor(options: { onError?: (error: unknown) => void } = {}) {
		this.onError = options.onError ?? (() => {});
	}

	/** Use these hooks from now on; `isOn` is asked again before every call. */
	set(registered: readonly RegisteredHooks[], isOn: (feature: EeFeatureId) => boolean): void {
		this.registered = [...registered];
		this.isOn = isOn;
	}

	/** No hooks: core only. */
	clear(): void {
		this.registered = [];
		this.isOn = () => false;
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
