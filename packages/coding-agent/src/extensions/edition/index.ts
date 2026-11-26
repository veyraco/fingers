/**
 * Open core: the built-in extension through which ee features act on a session (F14 token saving and later ee
 * features). It is MIT and holds no ee logic: it passes each tool result to the ee tool hooks of the features that
 * are on (core/edition/tool-hooks.ts), adds their tool guidelines to the system prompt, and tells them when the
 * model's context was rebuilt. With no hooks (core only, signed out, a tier without the feature, managed RPC, print
 * and JSON modes) it changes nothing.
 */

import { type EditionToolHooks, editionToolHooks, savingsLedger } from "../../core/edition/tool-hooks.ts";
import type { EeToolResult } from "../../core/edition/types.ts";
import type { ExtensionFactory } from "../../core/extensions/types.ts";
import type { SavingsLedger } from "../../core/savings-ledger.ts";
import { resolveReadPathAsync, resolveToCwd } from "../../core/tools/path-utils.ts";

export interface EditionExtensionOptions {
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

		fingers.on("session_start", (event) => {
			hooks.contextReset();
			// Another conversation: its savings start from zero. A reload keeps the conversation and its ledger.
			if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") savings.clear();
		});
		fingers.on("session_compact", () => hooks.contextReset());
		fingers.on("session_tree", () => hooks.contextReset());
	};
}

export default createEditionExtension();
