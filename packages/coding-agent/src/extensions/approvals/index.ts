/**
 * Approvals in the interactive terminal (canvas FingersTuiSession, "Approval needed · run a command").
 *
 * Before a shell command runs, the approval box asks unless the command matches the allow list: the
 * built-in read-only commands (with their arguments checked), the `approvals.allow` setting, and what
 * "always allow" added in this process. `approvals.commands: "never"` turns the box off. Only the TUI
 * asks; print, JSON and RPC modes are unchanged (managed RPC mode has its own approvals over the
 * protocol).
 *
 * Every answer from the box, and every command an allow rule from the settings or "always allow" let
 * through, is written to the session as an `approval` entry (not sent to the model): the audit record
 * of the terminal's approvals, with the session id and tool call id to correlate it. Writing to stderr
 * would draw over the TUI. Built-in read-only commands are not recorded.
 *
 * The canvas box also shows "Hooks: pre-command ✓ passed"; that line waits for org hooks (F23).
 */

import { commandAllowPattern, isBuiltInAllowedCommand, isCommandAllowed } from "../../core/command-allow-list.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { type ApprovalAnswer, ApprovalBoxComponent } from "../../modes/interactive/components/approval-box.ts";

const COMMAND_TOOLS = new Set(["bash", "powershell"]);

export type AskForApproval = (
	ctx: ExtensionContext,
	request: { command: string; allowPattern: string; reason: string },
) => Promise<ApprovalAnswer>;

/** Shows the approval box inline above the editor and resolves with the answer. */
export const askInTerminal: AskForApproval = (ctx, request) =>
	ctx.ui.custom<ApprovalAnswer>(
		(_tui, _theme, _keybindings, done) =>
			new ApprovalBoxComponent({
				action: "run a command",
				summary: request.command,
				isCommand: true,
				reason: request.reason,
				allowPattern: request.allowPattern,
				onAnswer: done,
			}),
		{ blocked: { kind: "permission", message: `Approve: ${request.command}` } },
	);

export function deniedReason(answer: Extract<ApprovalAnswer, { decision: "deny" }>): string {
	return answer.message
		? `The user did not allow this command and said what to do instead: ${answer.message}`
		: "The user did not allow this command.";
}

/** The session entry for one approval decision (`customType: "approval"`). */
export interface ApprovalRecord {
	sessionId: string;
	toolCallId: string;
	tool: string;
	command: string;
	/** The prefix "always allow" adds, or added. */
	pattern: string;
	decision: "allow_once" | "allow_always" | "deny" | "allowed_by_rule";
	/** For `allowed_by_rule`: whether the rule came from the settings or from "always allow". */
	rule?: "settings" | "session";
	/** What the person told Fingers to do instead, for `deny`. */
	message?: string;
}

export const APPROVAL_ENTRY_TYPE = "approval";

export function createApprovalsExtension(options: { ask?: AskForApproval } = {}): ExtensionFactory {
	const ask = options.ask ?? askInTerminal;
	return (fingers: ExtensionAPI) => {
		const allowedThisSession = new Set<string>();

		fingers.on("tool_call", async (event, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI || !COMMAND_TOOLS.has(event.toolName)) return undefined;
			const settings = fingers.getSettings().approvals;
			if (settings?.commands === "never") return undefined;
			const input = event.input as { command?: unknown };
			const command = typeof input.command === "string" ? input.command : "";
			if (!command.trim()) return undefined;
			if (isBuiltInAllowedCommand(command)) return undefined;

			const allowPattern = commandAllowPattern(command);
			const record = (decision: ApprovalRecord["decision"], extra: Partial<ApprovalRecord> = {}) =>
				fingers.appendEntry<ApprovalRecord>(APPROVAL_ENTRY_TYPE, {
					sessionId: ctx.sessionManager.getSessionId(),
					toolCallId: event.toolCallId,
					tool: event.toolName,
					command,
					pattern: allowPattern,
					decision,
					...extra,
				});

			if (isCommandAllowed(command, settings?.allow ?? [])) {
				record("allowed_by_rule", { rule: "settings" });
				return undefined;
			}
			if (isCommandAllowed(command, allowedThisSession)) {
				record("allowed_by_rule", { rule: "session" });
				return undefined;
			}

			const answer = await ask(ctx, { command, allowPattern, reason: "Not in your allow list." });
			if (answer.decision === "deny") {
				record("deny", answer.message ? { message: answer.message } : {});
				return { block: true, reason: deniedReason(answer) };
			}
			record(answer.decision);
			if (answer.decision === "allow_always") allowedThisSession.add(allowPattern);
			return undefined;
		});
	};
}

export default createApprovalsExtension();
