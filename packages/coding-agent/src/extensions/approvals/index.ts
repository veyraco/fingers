/**
 * Approvals in the interactive terminal (canvas FingersTuiSession, "Approval needed · run a command").
 *
 * Before a shell command runs, the approval box asks unless the command matches the allow list: the
 * built-in read-only commands (with their arguments checked; bash only, never PowerShell or a
 * `shellPath` that quotes unlike bash), the `approvals.allow` setting, and what "always allow" added in
 * this process. Built-in commands ask too while the shell's PATH has a folder the write tool can fill
 * without asking (`.`, a relative or empty entry, one in the project or the temporary directory), where
 * `ls` could resolve to a planted program. The write and edit tools ask before changing a file outside
 * the working directory (the temporary directory is exempt), a file with other hard links, and,
 * wherever they are, Fingers' agent directory, the project's `.fingers` directory, the shell startup
 * files and the files BASH_ENV, ENV and RIPGREP_CONFIG_PATH name (protected-paths.ts).
 * `approvals.commands: "never"` turns the box off.
 * The approval settings and `shellPath` come from the agent directory's settings only. Only the TUI
 * asks; print, JSON and RPC modes are unchanged (managed RPC mode has its own approvals over the
 * protocol).
 *
 * Every answer from the box, and every command a rule let through (built in, the settings or "always
 * allow"), is written to the session as an `approval` entry (not sent to the model): the audit record
 * of the terminal's approvals, with the session id and tool call id to correlate it. Writing to stderr
 * would draw over the TUI.
 *
 * The canvas box also shows "Hooks: pre-command ✓ passed"; that line waits for org hooks (F23).
 */

import {
	commandAllowPattern,
	commandShellOf,
	isBuiltInAllowedCommand,
	isCommandAllowed,
} from "../../core/command-allow-list.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ToolCallEventResult,
} from "../../core/extensions/types.ts";
import { pathEntryWritableWithoutAsking, writeApprovalReason } from "../../core/protected-paths.ts";
import { resolveToCwd } from "../../core/tools/path-utils.ts";
import { type ApprovalAnswer, ApprovalBoxComponent } from "../../modes/interactive/components/approval-box.ts";
import { getShellConfig, getShellEnv } from "../../utils/shell.ts";

const COMMAND_TOOLS = new Set(["bash", "powershell"]);
const FILE_WRITE_TOOLS = new Set(["write", "edit"]);

/** bash expands `~/…` PATH entries to the home directory; zsh and dash do not (see pathEntryWritableWithoutAsking). */
function shellExpandsTildeInPath(shellPath: string | undefined): boolean {
	try {
		const { shell } = getShellConfig(shellPath);
		return (shell.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "") === "bash";
	} catch {
		return false;
	}
}

export type AskForApproval = (
	ctx: ExtensionContext,
	/** `command` is the command line, or for a file write the tool and path (`write /x/settings.json`). */
	request: { command: string; allowPattern: string; reason: string; kind?: "command" | "file_write" },
) => Promise<ApprovalAnswer>;

/** Shows the approval box inline above the editor and resolves with the answer. */
export const askInTerminal: AskForApproval = (ctx, request) =>
	ctx.ui.custom<ApprovalAnswer>(
		(_tui, _theme, _keybindings, done) =>
			new ApprovalBoxComponent({
				action: request.kind === "file_write" ? "change a file" : "run a command",
				summary: request.command,
				isCommand: request.kind !== "file_write",
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
	/** The prefix "always allow" adds, or added; for a file write, the file's absolute path. */
	pattern: string;
	decision: "allow_once" | "allow_always" | "deny" | "allowed_by_rule";
	/** For `allowed_by_rule`: the built-in read-only list, the settings, or "always allow". */
	rule?: "built_in" | "settings" | "session";
	/** What the person told Fingers to do instead, for `deny`. */
	message?: string;
}

export const APPROVAL_ENTRY_TYPE = "approval";

export function createApprovalsExtension(options: { ask?: AskForApproval } = {}): ExtensionFactory {
	const ask = options.ask ?? askInTerminal;
	return (fingers: ExtensionAPI) => {
		const allowedThisSession = new Set<string>();
		const filesAllowedThisSession = new Set<string>();

		fingers.on("tool_call", async (event, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) return undefined;
			const isCommand = COMMAND_TOOLS.has(event.toolName);
			if (!isCommand && !FILE_WRITE_TOOLS.has(event.toolName)) return undefined;
			const allSettings = fingers.getSettings();
			const settings = allSettings.approvals;
			if (settings?.commands === "never") return undefined;
			const cwd = ctx.cwd ?? process.cwd();

			const recorder =
				(command: string, pattern: string) =>
				(decision: ApprovalRecord["decision"], extra: Partial<ApprovalRecord> = {}) =>
					fingers.appendEntry<ApprovalRecord>(APPROVAL_ENTRY_TYPE, {
						sessionId: ctx.sessionManager.getSessionId(),
						toolCallId: event.toolCallId,
						tool: event.toolName,
						command,
						pattern,
						decision,
						...extra,
					});
			const askAndRecord = async (
				request: Parameters<AskForApproval>[1],
				record: ReturnType<typeof recorder>,
				remember: Set<string>,
			): Promise<ToolCallEventResult | undefined> => {
				const answer = await ask(ctx, request);
				if (answer.decision === "deny") {
					record("deny", answer.message ? { message: answer.message } : {});
					return { block: true, reason: deniedReason(answer) };
				}
				record(answer.decision);
				if (answer.decision === "allow_always") remember.add(request.allowPattern);
				return undefined;
			};

			if (!isCommand) {
				const input = event.input as { path?: unknown };
				if (typeof input.path !== "string" || !input.path.trim()) return undefined;
				const reason = writeApprovalReason(input.path, cwd);
				if (!reason) return undefined;
				const target = resolveToCwd(input.path, cwd);
				const summary = `${event.toolName} ${target}`;
				const record = recorder(summary, target);
				if (filesAllowedThisSession.has(target)) {
					record("allowed_by_rule", { rule: "session" });
					return undefined;
				}
				return askAndRecord(
					{ command: summary, allowPattern: target, reason, kind: "file_write" },
					record,
					filesAllowedThisSession,
				);
			}

			const input = event.input as { command?: unknown };
			const command = typeof input.command === "string" ? input.command : "";
			if (!command.trim()) return undefined;
			const shell = commandShellOf(event.toolName, allSettings.shellPath);
			const allowPattern = commandAllowPattern(command);
			const record = recorder(command, allowPattern);

			const shellEnv = getShellEnv();
			const builtIn = isBuiltInAllowedCommand(command, shell, shellEnv);
			const plantablePathEntry = builtIn
				? pathEntryWritableWithoutAsking(cwd, shellEnv, {
						tildeExpands: shellExpandsTildeInPath(allSettings.shellPath),
					})
				: undefined;
			if (builtIn && plantablePathEntry === undefined) {
				record("allowed_by_rule", { rule: "built_in" });
				return undefined;
			}
			if (isCommandAllowed(command, settings?.allow ?? [], shell)) {
				record("allowed_by_rule", { rule: "settings" });
				return undefined;
			}
			if (isCommandAllowed(command, allowedThisSession, shell)) {
				record("allowed_by_rule", { rule: "session" });
				return undefined;
			}

			const reason =
				shell === "other"
					? "Your shellPath is not bash, sh, dash or zsh, so every command asks."
					: plantablePathEntry !== undefined
						? `Your PATH has a folder Fingers can write to without asking (${JSON.stringify(plantablePathEntry)}), so built-in commands ask.`
						: "Not in your allow list.";
			return askAndRecord({ command, allowPattern, reason }, record, allowedThisSession);
		});
	};
}

export default createApprovalsExtension();
