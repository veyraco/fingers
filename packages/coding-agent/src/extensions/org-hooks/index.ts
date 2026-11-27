/**
 * Open core: the built-in extension through which ee tool-call hooks (organization hooks from Connect's Fingers
 * policy) see every tool call before it runs. It is MIT and holds no ee logic: it hands the call to the ee hooks of
 * the features that are on (core/edition/tool-hooks.ts) and carries out their answer. With no such hooks (core only,
 * signed out, a tier without the feature, managed RPC, print and JSON modes) it changes nothing.
 *
 * - `block`: the call does not run; the model gets the reason.
 * - `ask`: the terminal app shows the approval box (canvas FingersTuiSession) with the hook's message and no "always
 *   allow": the organization wants the person to answer every time. Where no one can be asked, the call does not run.
 *
 * Every decision is written to the session as an `org_hook` entry (not sent to the model): the audit record, with the
 * session id and tool call id to correlate it. It runs before the personal `approvals` extension, so a call the
 * organization blocks never asks the person first.
 */

import { type EditionToolHooks, editionToolHooks } from "../../core/edition/tool-hooks.ts";
import type { EeToolCall } from "../../core/edition/types.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ToolCallEvent,
	ToolCallEventResult,
} from "../../core/extensions/types.ts";
import { resolveReadPathAsync, resolveToCwd } from "../../core/tools/path-utils.ts";
import { type ApprovalAnswer, ApprovalBoxComponent } from "../../modes/interactive/components/approval-box.ts";

/** Tools whose subject is a path (`input.path`); with none they work in the working directory. */
const PATH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const COMMAND_TOOLS = new Set(["bash", "powershell"]);

export type AskOrgHook = (
	ctx: ExtensionContext,
	request: { summary: string; isCommand: boolean; reason: string },
) => Promise<ApprovalAnswer>;

/** Shows the approval box, without "always allow", above the editor and resolves with the answer. */
export const askOrgHookInTerminal: AskOrgHook = (ctx, request) =>
	ctx.ui.custom<ApprovalAnswer>(
		(_tui, _theme, _keybindings, done) =>
			new ApprovalBoxComponent({
				action: request.isCommand ? "run a command" : "use a tool",
				summary: request.summary,
				isCommand: request.isCommand,
				reason: request.reason,
				allowPattern: request.summary,
				allowAlways: false,
				onAnswer: done,
			}),
		{ blocked: { kind: "permission", message: `Approve: ${request.summary}` } },
	);

/** The session entry for one organization-hook decision (`customType: "org_hook"`). */
export interface OrgHookRecord {
	sessionId: string;
	toolCallId: string;
	tool: string;
	/** What decided, e.g. `organization hook “no-force-push”`. */
	source: string;
	decision: "blocked" | "allow_once" | "deny" | "no_one_to_ask";
	/** What the person told Fingers to do instead, for `deny`. */
	message?: string;
}

export const ORG_HOOK_ENTRY_TYPE = "org_hook";

async function callPath(event: ToolCallEvent, cwd: string): Promise<string | undefined> {
	if (!PATH_TOOLS.has(event.toolName)) return undefined;
	const path = (event.input as Record<string, unknown>).path;
	if (path === undefined || path === "") return resolveToCwd(".", cwd);
	if (typeof path !== "string") return undefined;
	try {
		return event.toolName === "read" ? await resolveReadPathAsync(path, cwd) : resolveToCwd(path, cwd);
	} catch {
		return undefined;
	}
}

/** What the box shows: the command, or the tool and its path. */
function callSummary(event: ToolCallEvent, path: string | undefined): string {
	const input = event.input as Record<string, unknown>;
	if (COMMAND_TOOLS.has(event.toolName) && typeof input.command === "string") return input.command;
	return path ? `${event.toolName} ${path}` : event.toolName;
}

export function createOrgHooksExtension(
	options: { hooks?: EditionToolHooks; ask?: AskOrgHook } = {},
): ExtensionFactory {
	const hooks = options.hooks ?? editionToolHooks;
	const ask = options.ask ?? askOrgHookInTerminal;
	return (fingers: ExtensionAPI) => {
		fingers.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
			if (!hooks.hasToolCallHooks) return undefined;
			const cwd = ctx.cwd ?? process.cwd();
			const path = await callPath(event, cwd);
			const call: EeToolCall = {
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				nested: event.parentToolCallId !== undefined,
				input: event.input as Record<string, unknown>,
				cwd,
			};
			if (path) call.path = path;
			const decision = await hooks.beforeToolCall(call);
			if (!decision) return undefined;
			const record = (outcome: OrgHookRecord["decision"], message?: string) =>
				fingers.appendEntry<OrgHookRecord>(ORG_HOOK_ENTRY_TYPE, {
					sessionId: ctx.sessionManager.getSessionId(),
					toolCallId: event.toolCallId,
					tool: event.toolName,
					source: decision.source,
					decision: outcome,
					...(message ? { message } : {}),
				});
			if (decision.decision === "block") {
				record("blocked");
				return {
					block: true,
					reason: `Your organization's policy does not allow this call (${decision.source}): ${decision.message}`,
				};
			}
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				record("no_one_to_ask");
				return {
					block: true,
					reason: `Your organization's policy needs a person to approve this call (${decision.source}), and no one can be asked here: ${decision.message}`,
				};
			}
			const answer = await ask(ctx, {
				summary: callSummary(event, path),
				isCommand: COMMAND_TOOLS.has(event.toolName),
				reason: `Organization policy (${decision.source}): ${decision.message}`,
			});
			if (answer.decision === "deny") {
				record("deny", answer.message);
				return {
					block: true,
					reason: answer.message
						? `The user did not allow this call and said what to do instead: ${answer.message}`
						: "The user did not allow this call.",
				};
			}
			// The box offers no "always allow": every answer is for this call only.
			record("allow_once");
			return undefined;
		});
	};
}

export default createOrgHooksExtension();
