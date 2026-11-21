import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isBuiltInAllowedCommand } from "../src/core/command-allow-list.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { protectedWriteReason } from "../src/core/protected-paths.ts";
import {
	type ApprovalRecord,
	type AskForApproval,
	createApprovalsExtension,
} from "../src/extensions/approvals/index.ts";
import type { ApprovalAnswer } from "../src/modes/interactive/components/approval-box.ts";
import { getShellEnv } from "../src/utils/shell.ts";

const AGENT_DIR_ENV = "FINGERS_CODING_AGENT_DIR";

let root: string;
let agentDir: string;
let projectDir: string;
let savedAgentDir: string | undefined;
let savedPath: string | undefined;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "fingers-protected-")));
	agentDir = join(root, "home", ".fingers", "agent");
	projectDir = join(root, "project");
	mkdirSync(join(agentDir, "bin"), { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	savedAgentDir = process.env[AGENT_DIR_ENV];
	savedPath = process.env.PATH;
	process.env[AGENT_DIR_ENV] = agentDir;
});

afterEach(() => {
	if (savedAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = savedAgentDir;
	process.env.PATH = savedPath;
	rmSync(root, { recursive: true, force: true });
});

describe("shell commands' PATH", () => {
	it("leaves out the agent bin directory, where the write tool could replace rg", () => {
		const binDir = join(agentDir, "bin");
		process.env.PATH = [binDir, "/usr/bin", `${binDir}/`, "/bin"].join(delimiter);
		const path = getShellEnv().PATH ?? "";
		expect(path.split(delimiter)).toEqual(["/usr/bin", "/bin"]);
	});

	it.skipIf(process.platform === "win32")("does not resolve a built-in command into the agent bin directory", () => {
		// A planted rg in the agent bin directory, and no other rg on PATH.
		const planted = join(agentDir, "bin", "rg");
		const marker = join(root, "PLANTED");
		writeFileSync(planted, `#!/bin/sh\ntouch '${marker}'\n`);
		chmodSync(planted, 0o755);
		const emptyBin = join(root, "empty-bin");
		mkdirSync(emptyBin);
		process.env.PATH = [join(agentDir, "bin"), emptyBin].join(delimiter);

		expect(isBuiltInAllowedCommand("rg foo")).toBe(true);
		const result = spawnSync("/bin/sh", ["-c", "command -v rg; rg foo"], { env: getShellEnv(), encoding: "utf8" });
		expect(result.stdout).not.toContain(planted);
		expect(existsSync(marker)).toBe(false);
	});
});

describe("protectedWriteReason", () => {
	it("protects the agent directory and the project's .fingers directory", () => {
		expect(protectedWriteReason(join(agentDir, "bin", "rg"), projectDir)).toMatch(/Fingers' own directory/);
		expect(protectedWriteReason(join(agentDir, "settings.json"), projectDir)).toMatch(/Fingers' own directory/);
		expect(protectedWriteReason(join(agentDir, "extensions", "x.ts"), projectDir)).toMatch(/Fingers' own/);
		expect(protectedWriteReason(".fingers/settings.json", projectDir)).toMatch(/project's Fingers settings/);
		expect(protectedWriteReason("@.fingers/extensions/x.ts", projectDir)).toMatch(/project's Fingers/);
		expect(protectedWriteReason("sub/../.fingers/settings.json", projectDir)).toMatch(/project's Fingers/);
	});

	it("leaves other files alone", () => {
		expect(protectedWriteReason("src/index.ts", projectDir)).toBeUndefined();
		expect(protectedWriteReason(".fingers-notes.md", projectDir)).toBeUndefined();
		expect(protectedWriteReason(join(root, "home", ".fingers", "agent-old", "x"), projectDir)).toBeUndefined();
		expect(protectedWriteReason("sub/.fingers/settings.json", projectDir)).toBeUndefined();
	});

	it.skipIf(process.platform === "win32")("follows symlinks, dangling ones included", () => {
		// node_modules/.bin/tsc -> the agent's rg: writing tsc writes rg.
		mkdirSync(join(projectDir, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(agentDir, "bin", "rg"), "");
		symlinkSync(join(agentDir, "bin", "rg"), join(projectDir, "node_modules", ".bin", "tsc"));
		expect(protectedWriteReason("node_modules/.bin/tsc", projectDir)).toMatch(/Fingers' own directory/);
		// A dangling link: writing through it creates the target.
		symlinkSync(join(agentDir, "bin", "fd"), join(projectDir, "fd-link"));
		expect(protectedWriteReason("fd-link", projectDir)).toMatch(/Fingers' own directory/);
		// A linked directory.
		symlinkSync(agentDir, join(projectDir, "agent-link"));
		expect(protectedWriteReason("agent-link/settings.json", projectDir)).toMatch(/Fingers' own directory/);
		symlinkSync(join(projectDir, ".fingers"), join(projectDir, "dot-link"));
		expect(protectedWriteReason("dot-link/settings.json", projectDir)).toMatch(/project's Fingers/);
	});

	it.skipIf(process.platform !== "darwin")("ignores case on macOS, whose file system usually does", () => {
		expect(protectedWriteReason(".FINGERS/settings.json", projectDir)).toMatch(/project's Fingers/);
		expect(protectedWriteReason(join(agentDir, "BIN", "rg"), projectDir)).toMatch(/Fingers' own directory/);
	});
});

describe("approvals for the write and edit tools", () => {
	type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

	function setup(answers: ApprovalAnswer[], settings: Record<string, unknown> = {}) {
		const asked: Array<Parameters<AskForApproval>[1]> = [];
		const ask: AskForApproval = async (_ctx, request) => {
			asked.push(request);
			const answer = answers.shift();
			if (!answer) throw new Error("unexpected question");
			return answer;
		};
		let handler: Handler | undefined;
		const records: ApprovalRecord[] = [];
		const api = {
			on: (event: string, fn: Handler) => {
				if (event === "tool_call") handler = fn;
				return () => {};
			},
			getSettings: () => settings,
			appendEntry: (_type: string, data: ApprovalRecord) => records.push(data),
		} as unknown as ExtensionAPI;
		createApprovalsExtension({ ask })(api);
		const call = (toolName: string, path: string, mode: ExtensionContext["mode"] = "tui") =>
			handler!({ type: "tool_call", toolCallId: "t1", toolName, input: { path, content: "x" } }, {
				mode,
				hasUI: mode === "tui",
				cwd: projectDir,
				sessionManager: { getSessionId: () => "session-1" },
			} as unknown as ExtensionContext);
		return { asked, call, records };
	}

	it("asks before changing the agent directory or the project's .fingers directory", async () => {
		const { asked, call, records } = setup([{ decision: "deny" }, { decision: "deny" }, { decision: "allow_once" }]);
		expect(await call("write", join(agentDir, "bin", "rg"))).toMatchObject({ block: true });
		expect(await call("edit", ".fingers/settings.json")).toMatchObject({ block: true });
		expect(await call("write", join(agentDir, "settings.json"))).toBeUndefined();
		expect(asked.map((request) => request.kind)).toEqual(["file_write", "file_write", "file_write"]);
		expect(asked[1]).toMatchObject({
			command: `edit ${join(projectDir, ".fingers", "settings.json")}`,
			allowPattern: join(projectDir, ".fingers", "settings.json"),
		});
		expect(records.map((record) => record.decision)).toEqual(["deny", "deny", "allow_once"]);
	});

	it("writes other files without asking, and asks only in the terminal", async () => {
		const { asked, call } = setup([]);
		expect(await call("write", "src/index.ts")).toBeUndefined();
		expect(await call("write", join(agentDir, "bin", "rg"), "print")).toBeUndefined();
		expect(asked).toEqual([]);
	});

	it("remembers 'always allow' for that file only", async () => {
		const { asked, call, records } = setup([{ decision: "allow_always" }, { decision: "deny" }]);
		await call("write", ".fingers/settings.json");
		expect(await call("edit", ".fingers/settings.json")).toBeUndefined();
		expect(records.at(-1)).toMatchObject({ decision: "allowed_by_rule", rule: "session" });
		expect(await call("write", ".fingers/other.json")).toMatchObject({ block: true });
		expect(asked).toHaveLength(2);
	});

	it('does not ask when approvals.commands is "never"', async () => {
		const { asked, call } = setup([], { approvals: { commands: "never" } });
		expect(await call("write", join(agentDir, "bin", "rg"))).toBeUndefined();
		expect(asked).toEqual([]);
	});
});
