import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	linkSync,
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
import {
	pathEntryWritableWithoutAsking,
	protectedWriteReason,
	writeApprovalReason,
} from "../src/core/protected-paths.ts";
import {
	type ApprovalRecord,
	type AskForApproval,
	createApprovalsExtension,
} from "../src/extensions/approvals/index.ts";
import type { ApprovalAnswer } from "../src/modes/interactive/components/approval-box.ts";
import { checkManagedToolPaths, preparePathPolicy } from "../src/modes/rpc/managed/path-policy.ts";
import { getShellConfig, getShellEnv } from "../src/utils/shell.ts";

const AGENT_DIR_ENV = "FINGERS_CODING_AGENT_DIR";

let root: string;
let agentDir: string;
let projectDir: string;
let savedAgentDir: string | undefined;
let savedPath: string | undefined;
let home: string;
const SAVED_ENV_KEYS = ["HOME", "ZDOTDIR", "BASH_ENV", "ENV", "RIPGREP_CONFIG_PATH"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "fingers-protected-")));
	agentDir = join(root, "home", ".fingers", "agent");
	projectDir = join(root, "project");
	mkdirSync(join(agentDir, "bin"), { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	savedAgentDir = process.env[AGENT_DIR_ENV];
	savedPath = process.env.PATH;
	process.env[AGENT_DIR_ENV] = agentDir;
	savedEnv = Object.fromEntries(SAVED_ENV_KEYS.map((key) => [key, process.env[key]]));
	for (const key of SAVED_ENV_KEYS) delete process.env[key];
	home = join(root, "home");
	process.env.HOME = home;
});

afterEach(() => {
	if (savedAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = savedAgentDir;
	process.env.PATH = savedPath;
	for (const key of SAVED_ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
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

	it("asks before writing outside the working directory, but not in the temporary directory (F10b)", async () => {
		// The test root is in the temporary directory; a home directory inside it would void the exemption.
		process.env.HOME = "/fingers-approvals-test-home";
		const { asked, call } = setup([{ decision: "deny" }, { decision: "deny" }, { decision: "deny" }]);
		expect(await call("write", "/etc/fingers-approval-test")).toMatchObject({ block: true });
		expect(await call("edit", join(process.cwd(), "outside.ts"))).toMatchObject({ block: true });
		expect(await call("write", join(tmpdir(), "fingers-scratch.txt"))).toBeUndefined();
		expect(await call("write", "~/.zshenv")).toMatchObject({ block: true });
		expect(asked.map((request) => request.reason)).toEqual([
			expect.stringMatching(/outside/i),
			expect.stringMatching(/outside/i),
			expect.stringMatching(/startup file/),
		]);
	});

	it('does not ask when approvals.commands is "never"', async () => {
		const { asked, call } = setup([], { approvals: { commands: "never" } });
		expect(await call("write", join(agentDir, "bin", "rg"))).toBeUndefined();
		expect(asked).toEqual([]);
	});
});

describe("shell startup files never run for shell commands (F10b)", () => {
	it.skipIf(process.platform === "win32")(
		"bash does not run the file BASH_ENV names, and ENV is not passed on",
		() => {
			const marker = join(root, "BASH_ENV_RAN");
			const startup = join(root, "startup.sh");
			writeFileSync(startup, `touch '${marker}'\n`);
			process.env.BASH_ENV = startup;
			process.env.ENV = startup;
			const env = getShellEnv();
			expect(env.BASH_ENV).toBeUndefined();
			expect(env.ENV).toBeUndefined();
			const { shell, args } = getShellConfig();
			const result = spawnSync(shell, [...args, "ls"], { env, cwd: projectDir });
			expect(result.status).toBe(0);
			expect(existsSync(marker)).toBe(false);
		},
	);

	it.skipIf(!existsSync("/bin/zsh"))("zsh runs with -f, so ~/.zshenv and $ZDOTDIR/.zshenv do not run", () => {
		const marker = join(root, "ZSHENV_RAN");
		mkdirSync(home, { recursive: true });
		writeFileSync(join(home, ".zshenv"), `touch '${marker}'\n`);
		const zdotdir = join(root, "zdotdir");
		mkdirSync(zdotdir);
		writeFileSync(join(zdotdir, ".zshenv"), `touch '${marker}'\n`);
		const config = getShellConfig("/bin/zsh");
		expect(config.args).toEqual(["-f", "-c"]);
		expect(spawnSync(config.shell, [...config.args, "ls"], { env: getShellEnv(), cwd: projectDir }).status).toBe(0);
		process.env.ZDOTDIR = zdotdir;
		expect(spawnSync(config.shell, [...config.args, "ls"], { env: getShellEnv(), cwd: projectDir }).status).toBe(0);
		expect(existsSync(marker)).toBe(false);
	});

	it("rg is not built in while RIPGREP_CONFIG_PATH names a config file, unless --no-config comes first", () => {
		const env = { ...process.env, RIPGREP_CONFIG_PATH: join(projectDir, ".ripgreprc") };
		expect(isBuiltInAllowedCommand("rg foo", "bash", env)).toBe(false);
		expect(isBuiltInAllowedCommand("rg -i foo src", "bash", env)).toBe(false);
		// `--no-config` as the value of -e, or after other words, is not trusted.
		expect(isBuiltInAllowedCommand("rg -e --no-config foo", "bash", env)).toBe(false);
		expect(isBuiltInAllowedCommand("rg foo --no-config", "bash", env)).toBe(false);
		expect(isBuiltInAllowedCommand("rg --no-config foo", "bash", env)).toBe(true);
		expect(isBuiltInAllowedCommand("rg --no-config --pre=sh foo", "bash", env)).toBe(false);
		expect(isBuiltInAllowedCommand("rg foo", "bash", { ...env, RIPGREP_CONFIG_PATH: "" })).toBe(true);
		// Without an env argument, the process environment counts.
		process.env.RIPGREP_CONFIG_PATH = join(projectDir, ".ripgreprc");
		expect(isBuiltInAllowedCommand("rg foo")).toBe(false);
	});

	it("file is not built in with -z, -Z or --uncompress, which run decompressors found on PATH", () => {
		for (const command of [
			"file -z x.gz",
			"file -Z x.gz",
			"file -bz x.gz",
			"file '-b z' x.gz",
			"file --uncompress x.gz",
			"file --uncompress-noreport x.gz",
			"file --unc x.gz",
		]) {
			expect(isBuiltInAllowedCommand(command), command).toBe(false);
		}
		expect(isBuiltInAllowedCommand("file -b x.gz")).toBe(true);
		expect(isBuiltInAllowedCommand("file --mime-type x.gz")).toBe(true);
	});
});

describe("protectedWriteReason: shell startup and config files (F10b)", () => {
	const startupFiles = [
		".zshenv",
		".zshrc",
		".zprofile",
		".zlogin",
		".zlogout",
		".bashrc",
		".bash_profile",
		".bash_login",
		".bash_logout",
		".profile",
	];

	it("protects the shell startup files in the home directory, also when Fingers runs there", () => {
		for (const name of startupFiles) {
			expect(protectedWriteReason(join(home, name), projectDir), name).toMatch(/startup file/);
			expect(protectedWriteReason(name, home), name).toMatch(/startup file/);
		}
		expect(protectedWriteReason("~/.zshenv", projectDir)).toMatch(/startup file/);
		// The same names elsewhere are ordinary files.
		expect(protectedWriteReason(".zshrc", projectDir)).toBeUndefined();
		expect(protectedWriteReason(join(home, "notes", ".bashrc"), projectDir)).toBeUndefined();
	});

	it("protects zsh's startup files in $ZDOTDIR", () => {
		const zdotdir = join(root, "zdot");
		process.env.ZDOTDIR = zdotdir;
		for (const name of [".zshenv", ".zshrc", ".zprofile", ".zlogin", ".zlogout"]) {
			expect(protectedWriteReason(join(zdotdir, name), projectDir), name).toMatch(/startup file/);
		}
	});

	it("protects the files BASH_ENV, ENV and RIPGREP_CONFIG_PATH name", () => {
		process.env.BASH_ENV = join(projectDir, "env.sh");
		process.env.ENV = "$HOME/.shrc";
		process.env.RIPGREP_CONFIG_PATH = join(projectDir, ".ripgreprc");
		expect(protectedWriteReason("env.sh", projectDir)).toMatch(/BASH_ENV/);
		expect(protectedWriteReason(join(home, ".shrc"), projectDir)).toMatch(/\bENV\b/);
		expect(protectedWriteReason(".ripgreprc", projectDir)).toMatch(/RIPGREP_CONFIG_PATH/);
		expect(protectedWriteReason("other.sh", projectDir)).toBeUndefined();
	});

	it.skipIf(process.platform === "win32")("follows a symlink in the project to a startup file", () => {
		symlinkSync(join(home, ".zshenv"), join(projectDir, "zshenv-link"));
		expect(protectedWriteReason("zshenv-link", projectDir)).toMatch(/startup file/);
	});
});

describe("writeApprovalReason: write and edit ask outside the working directory (F10b)", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = join(root, "tmp");
		mkdirSync(tempDir);
	});

	it("asks for any file outside the working directory, except in the temporary directory", () => {
		const options = { tempDir };
		expect(writeApprovalReason("src/a.ts", projectDir, options)).toBeUndefined();
		expect(writeApprovalReason(join(projectDir, "new", "a.ts"), projectDir, options)).toBeUndefined();
		expect(writeApprovalReason(join(root, "elsewhere", "a.ts"), projectDir, options)).toMatch(/outside/i);
		expect(writeApprovalReason("../elsewhere/a.ts", projectDir, options)).toMatch(/outside/i);
		expect(writeApprovalReason("~/notes.md", projectDir, options)).toMatch(/outside/i);
		expect(writeApprovalReason(join(tempDir, "scratch.txt"), projectDir, options)).toBeUndefined();
	});

	it("still asks for protected files inside the working directory or the temporary directory", () => {
		process.env.BASH_ENV = join(tempDir, "env.sh");
		expect(writeApprovalReason(join(tempDir, "env.sh"), projectDir, { tempDir })).toMatch(/BASH_ENV/);
		expect(writeApprovalReason(".fingers/settings.json", projectDir, { tempDir })).toMatch(/project's Fingers/);
		expect(writeApprovalReason(".zshenv", home, { tempDir })).toMatch(/startup file/);
	});

	it.skipIf(process.platform === "win32")("follows symlinks out of the working directory", () => {
		mkdirSync(join(root, "elsewhere"));
		symlinkSync(join(root, "elsewhere"), join(projectDir, "out-dir"));
		symlinkSync(join(root, "elsewhere", "missing.txt"), join(projectDir, "out-dangling"));
		expect(writeApprovalReason("out-dir/a.ts", projectDir, { tempDir })).toMatch(/outside/i);
		expect(writeApprovalReason("out-dangling", projectDir, { tempDir })).toMatch(/outside/i);
		// A link from the temporary directory back out is not exempt either.
		symlinkSync(join(root, "elsewhere"), join(tempDir, "out"));
		expect(writeApprovalReason(join(tempDir, "out", "a.ts"), projectDir, { tempDir })).toMatch(/outside/i);
	});

	it.skipIf(process.platform === "win32")("asks for a file with other hard links, which a write changes too", () => {
		mkdirSync(join(root, "elsewhere"));
		writeFileSync(join(root, "elsewhere", "shared.sh"), "echo hi\n");
		linkSync(join(root, "elsewhere", "shared.sh"), join(projectDir, "shared.sh"));
		expect(writeApprovalReason("shared.sh", projectDir, { tempDir })).toMatch(/hard link/);
	});

	it("gives no exemption when the temporary directory is the home directory or the file system root", () => {
		expect(writeApprovalReason(join(home, "notes.md"), projectDir, { tempDir: home })).toMatch(/outside/i);
		expect(writeApprovalReason(join(root, "x.md"), projectDir, { tempDir: "/" })).toMatch(/outside/i);
	});
});

describe("shell PATH entries the write tool could fill without asking (F10b)", () => {
	it("finds relative, empty and in-project or temporary entries", () => {
		const tempDir = join(root, "tmp");
		const check = (path: string) => pathEntryWritableWithoutAsking(projectDir, { PATH: path }, { tempDir });
		expect(check(["/usr/bin", "/bin"].join(delimiter))).toBeUndefined();
		expect(check([".", "/usr/bin"].join(delimiter))).toBe(".");
		expect(check(["/usr/bin", "", "/bin"].join(delimiter))).toBe("");
		expect(check(["node_modules/.bin", "/usr/bin"].join(delimiter))).toBe("node_modules/.bin");
		const projectBin = join(projectDir, "node_modules", ".bin");
		expect(check(["/usr/bin", projectBin].join(delimiter))).toBe(projectBin);
		expect(check([join(tempDir, "bin"), "/usr/bin"].join(delimiter))).toBe(join(tempDir, "bin"));
		expect(pathEntryWritableWithoutAsking(projectDir, {}, { tempDir })).toBeUndefined();
		// `~/bin`: zsh and dash look in ./~/bin, bash in the home directory.
		expect(check(["~/bin", "/usr/bin"].join(delimiter))).toBe("~/bin");
		const tilde = (cwd: string) =>
			pathEntryWritableWithoutAsking(cwd, { PATH: "~/bin", HOME: home }, { tempDir, tildeExpands: true });
		expect(tilde(projectDir)).toBeUndefined();
		expect(tilde(home)).toBe("~/bin");
	});
});

describe("managed mode refuses write and edit outside the workspace (F10b)", () => {
	it("refuses shell startup files and the temporary directory", async () => {
		const policy = await preparePathPolicy({ workspaceRoot: projectDir, protectedPaths: [] });
		expect(await checkManagedToolPaths("write", { path: join(home, ".zshenv") }, policy)).toMatch(/outside/);
		expect(await checkManagedToolPaths("edit", { path: "~/.bashrc" }, policy)).toMatch(/outside/);
		expect(await checkManagedToolPaths("write", { path: join(tmpdir(), "x.sh") }, policy)).toMatch(/outside/);
		expect(await checkManagedToolPaths("write", { path: "src/a.ts" }, policy)).toBeNull();
	});
});
