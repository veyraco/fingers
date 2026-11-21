/**
 * Command allow lists for approvals: a pattern is the first words of a command (`pnpm vitest`), and a
 * command matches when it starts with those words and does nothing else. Shared by the interactive
 * approval box and managed RPC mode.
 *
 * A bash command matches only when it parses as plain words (parsePlainBashWords). That parser accepts
 * the forms it can prove literal and nothing else, so any shell syntax it does not know asks. The
 * built-in list is checked more strictly than a pattern people add themselves: a built-in command runs
 * without asking only when none of its arguments can make it run another program or write a file. The
 * built-in list is for bash only: PowerShell commands match only patterns people add, and a command
 * for any other shell (a `shellPath` such as fish, whose quoting differs) matches nothing and asks.
 */

/**
 * The shell a command runs in: `bash` (also sh, dash and zsh, which quote the same way), `powershell`,
 * or `other` for a configured shell whose quoting the parser does not know.
 */
export type CommandShell = "bash" | "powershell" | "other";

/** Shells that quote like bash: the plain-words parser holds for them. */
const POSIX_SHELLS = new Set(["bash", "sh", "dash", "zsh"]);

/** A chained, piped, substituted or redirected PowerShell command could run anything after an allowed prefix. */
const POWERSHELL_CHAINING = /[;&|`\n\r<>]|\$\(/;

/**
 * PowerShell runs code inside arguments: `(…)` subexpressions, `$x`/`$env:X` variables, `@(…)`/`@x`
 * arrays and splats, `{…}` script blocks and `[Type]::Method()` calls. A PowerShell command with any of
 * them never matches an allow pattern.
 */
const POWERSHELL_CODE = /[(){}$@[\]]/;

/**
 * Characters bash passes on literally outside quotes. Left out: expansions (`$`, `` ` ``, `{`, `}`),
 * metacharacters (`;`, `&`, `|`, `<`, `>`, `(`, `)`, newline), comments (`#`), history (`!`) and `[`/`]`
 * (subscripts, bracket globs). `~` may expand, but only to a path; `^` is literal outside an interactive
 * shell (`HEAD^`). Letters, digits and marks of other scripts are literal too.
 */
const PLAIN_UNQUOTED = /^(?:[A-Za-z0-9_@%+=:,./~^-]|[\p{L}\p{N}\p{M}])$/u;

/** Glob characters that only match file names (`*.ts`). */
const GLOB = /^[*?]$/;

/** Characters that never count as plain text, quoted or not: control and format (bidi) characters, line breaks. */
const UNPRINTABLE = /^[\p{C}\p{Zl}\p{Zp}]$/u;

/** Characters that keep a special meaning inside double quotes: expansions and history. */
const DOUBLE_QUOTE_SPECIAL = new Set(["$", "`", "!"]);

/** Inside double quotes a backslash escapes only these (and a newline, which is never plain). */
const DOUBLE_QUOTE_ESCAPED = new Set(['"', "\\", "$", "`"]);

/** A word of a plain bash command, after quote removal. */
export interface ShellWord {
	/** What the program receives; for a glob word, the pattern that file names may replace. */
	value: string;
	/** Has an unquoted `*` or `?`: bash may replace the word with file names, so its value is not known. */
	glob: boolean;
}

/**
 * Parses a bash command made only of plain words, separated by spaces and tabs. A word is built from
 * unquoted literal characters, `*`/`?` globs, a backslash before a printable character, '…' (any
 * printable text) and "…" (printable text without `$`, `` ` `` or `!`).
 *
 * Anything else gives undefined, and the command must ask. That covers `${…}`/`$x` parameter expansion,
 * `$(…)`, `$((…))` and backtick substitution, `$'…'` strings, `<(…)`/`>(…)` process substitution,
 * here-strings, here-documents and other redirections, `;`/`&`/`|`/newline, `(…)`/`{…}` and brace
 * expansion, `[…]` subscripts and globs, comments and history.
 *
 * Values are what the program receives, so quoting cannot hide an option from a check (`"--pre"=sh`).
 */
export function parsePlainBashWords(command: string): ShellWord[] | undefined {
	const words: ShellWord[] = [];
	const chars = [...command];
	let word: ShellWord | undefined;
	let index = 0;
	const current = (): ShellWord => {
		word ??= { value: "", glob: false };
		return word;
	};
	while (index < chars.length) {
		const char = chars[index++];
		if (char === " " || char === "\t") {
			if (word) words.push(word);
			word = undefined;
		} else if (char === "\\") {
			const next = chars[index++];
			if (next === undefined || UNPRINTABLE.test(next)) return undefined;
			current().value += next;
		} else if (char === "'") {
			const target = current();
			for (;;) {
				const next = chars[index++];
				if (next === undefined || UNPRINTABLE.test(next)) return undefined;
				if (next === "'") break;
				target.value += next;
			}
		} else if (char === '"') {
			const target = current();
			for (;;) {
				const next = chars[index++];
				if (next === undefined || UNPRINTABLE.test(next) || DOUBLE_QUOTE_SPECIAL.has(next)) return undefined;
				if (next === '"') break;
				if (next === "\\" && DOUBLE_QUOTE_ESCAPED.has(chars[index] ?? "")) {
					target.value += chars[index++];
				} else {
					target.value += next;
				}
			}
		} else if (GLOB.test(char)) {
			const target = current();
			target.value += char;
			target.glob = true;
		} else if (PLAIN_UNQUOTED.test(char)) {
			current().value += char;
		} else {
			return undefined;
		}
	}
	if (word) words.push(word);
	return words;
}

interface BuiltInCommand {
	/** The command's first words, as in a pattern. */
	pattern: string;
	/**
	 * Arguments must not be globs because some option is dangerous: a file named `--pre=sh` in the
	 * folder would become an option the check did not see.
	 */
	literalArguments?: boolean;
	/**
	 * Whether the arguments after the pattern (as the program receives them) are safe in the environment
	 * the shell gets; absent means any argument is.
	 */
	argumentsAreSafe?: (args: readonly string[], env: NodeJS.ProcessEnv) => boolean;
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

/**
 * Rejects short options such as `-C` alone or anywhere in a group (`-bC`, or `"-b C"`, which getopt
 * also reads letter by letter).
 */
function noShortOption(letters: string): (args: readonly string[]) => boolean {
	return (args) =>
		args.every(
			(arg) =>
				!arg.startsWith("-") ||
				arg.startsWith("--") ||
				![...arg.slice(1)].some((letter) => letters.includes(letter)),
		);
}

function all(...checks: Array<(args: readonly string[]) => boolean>): (args: readonly string[]) => boolean {
	return (args) => checks.every((check) => check(args));
}

/**
 * The git forms that run without asking, as exact argument lists. git runs programs named in the
 * repository's config whenever it reads the index (`core.fsmonitor`) or needs an object it lacks (a
 * lazy fetch from a promisor remote runs its transport: `ext::`, `core.sshCommand`). `git rev-parse
 * :path`, `<rev>^{commit}`, `<rev>~N`, `git branch -v` and even a plain `git branch` (with `branch.sort`
 * set) do that, and the write and edit tools can change `.git/config` and the refs without asking. These
 * forms only read the repository's location and HEAD's name: none of them reads the index or an object.
 */
const GIT_READ_ONLY_FORMS: ReadonlyMap<string, readonly (readonly string[])[]> = new Map([
	[
		"git rev-parse",
		[
			["--show-toplevel"],
			["--git-dir"],
			["--git-common-dir"],
			["--is-inside-work-tree"],
			["--is-bare-repository"],
			["--show-prefix"],
			["--show-cdup"],
			["--abbrev-ref", "HEAD"],
		],
	],
	["git branch", [["--show-current"]]],
]);

function exactArguments(pattern: string): (args: readonly string[]) => boolean {
	const forms = GIT_READ_ONLY_FORMS.get(pattern) ?? [];
	return (args) =>
		forms.some((form) => form.length === args.length && form.every((value, index) => args[index] === value));
}

/**
 * rg options that only change what is searched or printed. Everything else asks: `--pre`/`--pre-glob`
 * run a program on every file, `--hostname-bin` runs a program to name the host for hyperlinks,
 * `-z`/`--search-zip` runs decompressors found on PATH, and any option rg adds later is unknown here.
 */
const RG_FLAGS = new Set("iSsFwxnNlcvoHIuUaLq0bph".split(""));
/** Short options that take a value: the rest of a group (`-tpy`, `-A3`) or the next argument. */
const RG_SHORT_WITH_VALUE = new Set("efgtTABCmdMjrE".split(""));
const RG_LONG_OPTIONS = new Set([
	// Patterns and what to search.
	"regexp",
	"file",
	"glob",
	"iglob",
	"glob-case-insensitive",
	"type",
	"type-not",
	"type-list",
	"files",
	"hidden",
	"no-hidden",
	"follow",
	"no-follow",
	"no-ignore",
	"no-ignore-vcs",
	"no-ignore-parent",
	"no-ignore-dot",
	"no-ignore-global",
	"no-ignore-exclude",
	"no-ignore-files",
	"ignore",
	"unrestricted",
	"max-depth",
	"max-filesize",
	"one-file-system",
	"text",
	"binary",
	"no-binary",
	"no-config",
	// How to match.
	"ignore-case",
	"smart-case",
	"case-sensitive",
	"fixed-strings",
	"no-fixed-strings",
	"word-regexp",
	"line-regexp",
	"invert-match",
	"multiline",
	"multiline-dotall",
	"crlf",
	"pcre2",
	"no-pcre2",
	"encoding",
	"max-count",
	// What to print.
	"after-context",
	"before-context",
	"context",
	"context-separator",
	"line-number",
	"no-line-number",
	"column",
	"no-column",
	"byte-offset",
	"files-with-matches",
	"files-without-match",
	"count",
	"count-matches",
	"only-matching",
	"replace",
	"passthru",
	"with-filename",
	"no-filename",
	"heading",
	"no-heading",
	"vimgrep",
	"json",
	"no-json",
	"trim",
	"null",
	"quiet",
	"stats",
	"pretty",
	"color",
	"colors",
	"max-columns",
	"max-columns-preview",
	"no-messages",
	"include-zero",
	"sort",
	"sortr",
	"sort-files",
	"threads",
	"line-buffered",
	"block-buffered",
	"field-context-separator",
	"field-match-separator",
	"path-separator",
	"help",
	"version",
]);

/** One rg argument that starts with `-`: an option from the lists above, or `-`/`--`. */
function rgOptionIsSafe(arg: string): boolean {
	if (arg === "-" || arg === "--") return true;
	if (arg.startsWith("--")) return RG_LONG_OPTIONS.has(arg.slice(2).split("=", 1)[0]);
	for (const letter of arg.slice(1)) {
		if (RG_SHORT_WITH_VALUE.has(letter)) return true;
		if (!RG_FLAGS.has(letter)) return false;
	}
	return true;
}

/**
 * Every argument that starts with `-` must be a known safe option, wherever it is: an option that
 * takes a value can take the next argument (`-e --hostname-bin=x` searches for that text), but the
 * check does not try to tell values from options, and `--` does not end it (in `-e -- -z` rg reads
 * `--` as the pattern and `-z` as an option). Words without a leading `-` are patterns and paths.
 */
function rgArgumentsAreSafe(args: readonly string[], env: NodeJS.ProcessEnv): boolean {
	// rg prepends the options in the file RIPGREP_CONFIG_PATH names (`--pre=…` among them) unless
	// `--no-config` is given. Only a first argument is surely that option and not another option's value.
	if (env.RIPGREP_CONFIG_PATH && args[0] !== "--no-config") return false;
	return args.every((arg) => !arg.startsWith("-") || rgOptionIsSafe(arg));
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
 * `tree` (`-o` writes a file, and short options combine) and `git status`/`diff`/`log`/`show` and
 * every other git form outside GIT_READ_ONLY_FORMS: they run programs named in the repository's config
 * (`core.fsmonitor`, `diff.external`, a `textconv` driver, a promisor remote's transport), and the
 * write and edit tools can change `.git/config`, `.gitattributes` and the refs without asking.
 *
 * The names resolve on the PATH bash commands get (getShellEnv), which leaves out the agent's own bin
 * directory: Fingers downloads `rg` and `fd` there, and the write tool could replace them. The approvals
 * extension also asks while that PATH has an entry the write tool can fill without asking
 * (pathEntryWritableWithoutAsking), and `file -z` would run decompressors found on it.
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
	// Only known options: `--pre`, `--pre-glob`, `--hostname-bin` and `-z` run programs, and so can a
	// config file named by RIPGREP_CONFIG_PATH (then only `rg --no-config …` is built in).
	{ pattern: "rg", literalArguments: true, argumentsAreSafe: rgArgumentsAreSafe },
	// `-C`/`--compile` writes a compiled magic file; `-z`/`-Z`/`--uncompress` run decompressors found on PATH.
	{
		pattern: "file",
		literalArguments: true,
		argumentsAreSafe: all(noShortOption("CzZ"), noLongOption(["compile", "uncompress", "uncompress-noreport"])),
	},
	{ pattern: "date", literalArguments: true, argumentsAreSafe: datePrintsOnly },
	{ pattern: "git rev-parse", literalArguments: true, argumentsAreSafe: exactArguments("git rev-parse") },
	{ pattern: "git branch", literalArguments: true, argumentsAreSafe: exactArguments("git branch") },
];

/** The built-in commands' patterns, for docs and messages. */
export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = BUILT_IN_COMMANDS.map((command) => command.pattern);

export function commandTokens(command: string): string[] {
	return command.trim().split(/\s+/).filter(Boolean);
}

/**
 * The shell a command tool runs in. `shellPath` is the `shellPath` setting the bash tool uses; when it
 * names a shell other than bash, sh, dash or zsh, the command is `other` and no allow rule applies.
 */
export function commandShellOf(toolName: string, shellPath?: string): CommandShell {
	if (toolName === "powershell") return "powershell";
	if (!shellPath) return "bash";
	const name = (shellPath.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
	return POSIX_SHELLS.has(name) ? "bash" : "other";
}

/** What "always allow" adds for a command: its first two words (`pnpm vitest`). */
export function commandAllowPattern(command: string): string {
	return commandTokens(command).slice(0, 2).join(" ");
}

/** Whether the plain words start with every word of `pattern`, none of them a glob. */
function startsWithPattern(pattern: string, words: readonly ShellWord[]): boolean {
	const wanted = commandTokens(pattern);
	return (
		wanted.length > 0 &&
		wanted.every((token, index) => {
			const word = words[index];
			return word !== undefined && !word.glob && word.value === token;
		})
	);
}

/**
 * Whether `command` starts with every word of `pattern` and does nothing else. In bash it must be plain
 * words (parsePlainBashWords): no expansion, substitution, chaining or redirection. In PowerShell it must
 * not be chained or redirected nor carry code in its arguments. In any other shell nothing matches.
 */
export function commandMatchesPattern(pattern: string, command: string, shell: CommandShell = "bash"): boolean {
	if (shell === "other") return false;
	if (shell === "powershell") {
		if (POWERSHELL_CHAINING.test(command) || POWERSHELL_CODE.test(command)) return false;
		const wanted = commandTokens(pattern);
		const tokens = commandTokens(command);
		return wanted.length > 0 && wanted.every((token, index) => tokens[index] === token);
	}
	const words = parsePlainBashWords(command);
	return words !== undefined && startsWithPattern(pattern, words);
}

export function isCommandAllowed(command: string, patterns: Iterable<string>, shell: CommandShell = "bash"): boolean {
	for (const pattern of patterns) {
		if (commandMatchesPattern(pattern, command, shell)) return true;
	}
	return false;
}

/**
 * Whether `command` is a built-in command that runs without asking, with arguments that keep it
 * read-only. Always false for PowerShell and other shells, where the bash checks do not hold
 * (`echo (Start-Process x)`, fish's `\'` inside single quotes).
 */
export function isBuiltInAllowedCommand(
	command: string,
	shell: CommandShell = "bash",
	/** The environment the shell gets (getShellEnv); `RIPGREP_CONFIG_PATH` in it changes what rg runs. */
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (shell !== "bash") return false;
	const words = parsePlainBashWords(command);
	if (!words) return false;
	return BUILT_IN_COMMANDS.some((builtIn) => {
		if (!startsWithPattern(builtIn.pattern, words)) return false;
		const args = words.slice(commandTokens(builtIn.pattern).length);
		if (builtIn.literalArguments && args.some((arg) => arg.glob)) return false;
		return builtIn.argumentsAreSafe
			? builtIn.argumentsAreSafe(
					args.map((arg) => arg.value),
					env,
				)
			: true;
	});
}
