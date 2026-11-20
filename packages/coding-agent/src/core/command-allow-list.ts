/**
 * Command allow lists for approvals: a pattern is the first words of a command (`pnpm vitest`), and a
 * command matches when it starts with those words and does nothing else. Shared by the interactive
 * approval box and managed RPC mode.
 *
 * The built-in list is checked more strictly than a pattern people add themselves: a built-in command
 * runs without asking only when none of its arguments can make it run another program or write a file.
 * The built-in list is for bash only: PowerShell commands match only patterns people add.
 */

/** The shell a command runs in: `bash` (also sh/zsh) or `powershell`. */
export type CommandShell = "bash" | "powershell";

/** A chained, piped, substituted or redirected command could run anything after an allowed prefix. */
const SHELL_CHAINING = /[;&|`\n\r<>]|\$\(/;

/**
 * PowerShell runs code inside arguments: `(…)` subexpressions, `$x`/`$env:X` variables, `@(…)`/`@x`
 * arrays and splats, `{…}` script blocks and `[Type]::Method()` calls. A PowerShell command with any of
 * them never matches an allow pattern.
 */
const POWERSHELL_CODE = /[(){}$@[\]]/;

/**
 * An argument the shell passes on literally: no quotes, escapes, expansions, globs or braces, which
 * could turn into an option the check did not see (`"--pre"=sh`, `--${x}output`, a file named `--pre=sh`).
 * `~` may expand, but only to a path; `^` is literal outside an interactive shell (`HEAD^`).
 */
const LITERAL_ARGUMENT = /^[A-Za-z0-9_@%+=:,./~^-]+$/;

interface BuiltInCommand {
	/** The command's first words, as in a pattern. */
	pattern: string;
	/** Arguments must be literal (see LITERAL_ARGUMENT) because some option is dangerous. */
	literalArguments?: boolean;
	/** Whether the arguments after the pattern are safe; absent means any argument is. */
	argumentsAreSafe?: (args: readonly string[]) => boolean;
}

/** `--name` or `--name=value` → `name`; anything else → undefined. */
function longOptionName(arg: string): string | undefined {
	if (!arg.startsWith("--") || arg === "--") return undefined;
	return arg.slice(2).split("=", 1)[0];
}

/**
 * Rejects long options that are, or abbreviate, a forbidden one (git accepts any unambiguous prefix:
 * `--outp=x` is `--output=x`).
 */
function noLongOption(forbidden: readonly string[]): (args: readonly string[]) => boolean {
	return (args) =>
		args.every((arg) => {
			const name = longOptionName(arg);
			if (name === undefined) return true;
			return !forbidden.some((option) => option.startsWith(name) || name.startsWith(option));
		});
}

/** Rejects short options such as `-C` alone or in a group (`-bC`). */
function noShortOption(letters: string): (args: readonly string[]) => boolean {
	return (args) =>
		args.every((arg) => !/^-[A-Za-z]+$/.test(arg) || ![...arg.slice(1)].some((letter) => letters.includes(letter)));
}

function all(...checks: Array<(args: readonly string[]) => boolean>): (args: readonly string[]) => boolean {
	return (args) => checks.every((check) => check(args));
}

/** `git rev-parse`: no writing a file and no other git programs. */
const gitReadOnly = noLongOption(["output", "ext-diff", "exec-path"]);

/** `git branch` lists branches only: no name (that would create one) and no delete, move or force. */
const GIT_BRANCH_LISTING = new Set([
	"--all",
	"--remotes",
	"--list",
	"--verbose",
	"--show-current",
	"--color",
	"--no-color",
	"--column",
	"--no-column",
	"--no-abbrev",
]);
function gitBranchListsOnly(args: readonly string[]): boolean {
	return args.every((arg) => GIT_BRANCH_LISTING.has(arg) || /^-[arvl]+$/.test(arg));
}

/** `date` prints the time only: `+FORMAT` and UTC/format flags, never `-s`/`--set` or a date to set. */
function datePrintsOnly(args: readonly string[]): boolean {
	return args.every(
		(arg) => arg.startsWith("+") || /^-[uRj]+$/.test(arg) || /^-I[a-z]*$/.test(arg) || arg === "--utc",
	);
}

/**
 * Commands that run without asking in the interactive shell. None of them can run another program or
 * write a file with the arguments allowed here. Left out on purpose: `fd` (`-x`/`-X` run programs),
 * `tree` (`-o` writes a file, and short options combine) and `git status`/`diff`/`log`/`show`: they run
 * programs named in the repository's config (`core.fsmonitor`, `diff.external`, a `textconv` driver),
 * and the write and edit tools can change `.git/config` and `.gitattributes` without asking.
 * `git rev-parse` and listing `git branch` never run those programs.
 */
const BUILT_IN_COMMANDS: readonly BuiltInCommand[] = [
	{ pattern: "ls" },
	{ pattern: "pwd" },
	{ pattern: "cat" },
	{ pattern: "head" },
	{ pattern: "tail" },
	{ pattern: "wc" },
	{ pattern: "echo" },
	{ pattern: "which" },
	{ pattern: "grep" },
	{ pattern: "stat" },
	{ pattern: "du" },
	{ pattern: "df" },
	// `--pre`/`--pre-glob` run a program on every file searched.
	{ pattern: "rg", literalArguments: true, argumentsAreSafe: noLongOption(["pre", "pre-glob"]) },
	// `-C`/`--compile` writes a compiled magic file.
	{ pattern: "file", literalArguments: true, argumentsAreSafe: all(noShortOption("C"), noLongOption(["compile"])) },
	{ pattern: "date", literalArguments: true, argumentsAreSafe: datePrintsOnly },
	{ pattern: "git rev-parse", literalArguments: true, argumentsAreSafe: gitReadOnly },
	{ pattern: "git branch", literalArguments: true, argumentsAreSafe: gitBranchListsOnly },
];

/** The built-in commands' patterns, for docs and messages. */
export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = BUILT_IN_COMMANDS.map((command) => command.pattern);

export function commandTokens(command: string): string[] {
	return command.trim().split(/\s+/).filter(Boolean);
}

/** The shell a command tool runs in. */
export function commandShellOf(toolName: string): CommandShell {
	return toolName === "powershell" ? "powershell" : "bash";
}

/** What "always allow" adds for a command: its first two words (`pnpm vitest`). */
export function commandAllowPattern(command: string): string {
	return commandTokens(command).slice(0, 2).join(" ");
}

/**
 * Whether `command` starts with every word of `pattern` and is not chained or redirected (nor, in
 * PowerShell, carries code in its arguments).
 */
export function commandMatchesPattern(pattern: string, command: string, shell: CommandShell = "bash"): boolean {
	if (SHELL_CHAINING.test(command)) return false;
	if (shell === "powershell" && POWERSHELL_CODE.test(command)) return false;
	const wanted = commandTokens(pattern);
	const tokens = commandTokens(command);
	return wanted.length > 0 && wanted.every((token, index) => tokens[index] === token);
}

export function isCommandAllowed(command: string, patterns: Iterable<string>, shell: CommandShell = "bash"): boolean {
	for (const pattern of patterns) {
		if (commandMatchesPattern(pattern, command, shell)) return true;
	}
	return false;
}

/**
 * Whether `command` is a built-in command that runs without asking, with arguments that keep it
 * read-only. Always false for PowerShell, where the bash checks do not hold (`echo (Start-Process x)`).
 */
export function isBuiltInAllowedCommand(command: string, shell: CommandShell = "bash"): boolean {
	if (shell !== "bash") return false;
	const tokens = commandTokens(command);
	return BUILT_IN_COMMANDS.some((builtIn) => {
		if (!commandMatchesPattern(builtIn.pattern, command)) return false;
		const args = tokens.slice(commandTokens(builtIn.pattern).length);
		if (builtIn.literalArguments && !args.every((arg) => LITERAL_ARGUMENT.test(arg))) return false;
		return builtIn.argumentsAreSafe ? builtIn.argumentsAreSafe(args) : true;
	});
}
