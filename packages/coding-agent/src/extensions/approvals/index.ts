/**
 * Approvals in the interactive terminal (canvas FingersTuiSession, "Approval needed · run a command").
 *
 * Before a shell command runs, the approval box asks unless the command matches the allow list: the
 * built-in read-only commands, the `approvals.allow` setting, and what "always allow" added in this
 * process. `approvals.commands: "never"` turns the box off. Only the TUI asks; print, JSON and RPC
 * modes are unchanged (managed RPC mode has its own approvals over the protocol).
 */

import { commandAllowPattern, DEFAULT_ALLOWED_COMMANDS, isCommandAllowed } from "../../core/command-allow-list.ts";
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
			const patterns = [...DEFAULT_ALLOWED_COMMANDS, ...(settings?.allow ?? []), ...allowedThisSession];
			if (isCommandAllowed(command, patterns)) return undefined;

			const allowPattern = commandAllowPattern(command);
			const answer = await ask(ctx, { command, allowPattern, reason: "Not in your allow list." });
			if (answer.decision === "allow_always") {
				allowedThisSession.add(allowPattern);
				return undefined;
			}
			if (answer.decision === "allow_once") return undefined;
			return { block: true, reason: deniedReason(answer) };
		});
	};
}

export default createApprovalsExtension();
