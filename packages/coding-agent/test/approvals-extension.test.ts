import { describe, expect, it } from "vitest";
import { commandAllowPattern, commandMatchesPattern, isCommandAllowed } from "../src/core/command-allow-list.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import type { Settings } from "../src/core/settings-schema.ts";
import { type AskForApproval, createApprovalsExtension } from "../src/extensions/approvals/index.ts";
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
	const api = {
		on: (event: string, fn: Handler) => {
			if (event === "tool_call") handler = fn;
			return () => {};
		},
		getSettings: () => settings,
	} as unknown as ExtensionAPI;
	createApprovalsExtension({ ask })(api);
	const call = (command: string, mode: ExtensionContext["mode"] = "tui", toolName = "bash") =>
		handler!({ type: "tool_call", toolCallId: "t1", toolName, input: { command } }, {
			mode,
			hasUI: mode === "tui" || mode === "rpc",
		} as ExtensionContext);
	return { asked, call };
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
