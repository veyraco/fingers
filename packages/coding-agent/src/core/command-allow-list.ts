/**
 * Command allow lists for approvals: a pattern is the first words of a command (`pnpm vitest`), and a
 * command matches when it starts with those words and does nothing else. Shared by the interactive
 * approval box and managed RPC mode.
 */

/** A chained, piped, substituted or redirected command could run anything after an allowed prefix. */
const SHELL_CHAINING = /[;&|`\n\r<>]|\$\(/;

/** Read-only commands that run without asking in the interactive shell. */
export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
	"ls",
	"pwd",
	"cat",
	"head",
	"tail",
	"wc",
	"echo",
	"which",
	"rg",
	"grep",
	"fd",
	"tree",
	"file",
	"stat",
	"du",
	"df",
	"date",
	"git status",
	"git diff",
	"git log",
	"git show",
	"git branch",
	"git rev-parse",
];

export function commandTokens(command: string): string[] {
	return command.trim().split(/\s+/).filter(Boolean);
}

/** What "always allow" adds for a command: its first two words (`pnpm vitest`). */
export function commandAllowPattern(command: string): string {
	return commandTokens(command).slice(0, 2).join(" ");
}

/** Whether `command` starts with every word of `pattern` and is not chained or redirected. */
export function commandMatchesPattern(pattern: string, command: string): boolean {
	if (SHELL_CHAINING.test(command)) return false;
	const wanted = commandTokens(pattern);
	const tokens = commandTokens(command);
	return wanted.length > 0 && wanted.every((token, index) => tokens[index] === token);
}

export function isCommandAllowed(command: string, patterns: Iterable<string>): boolean {
	for (const pattern of patterns) {
		if (commandMatchesPattern(pattern, command)) return true;
	}
	return false;
}
