/**
 * `fingers login|logout|whoami` are dispatched by main() to the Veyra account commands before any session starts, so
 * `fingers login` signs in instead of starting a session whose first message is "login". Tests run with
 * FINGERS_CREDENTIAL_STORE=file (vitest config): the sign-in is in memory only, so nothing reaches a keychain or Connect.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isVeyraAccountCommand } from "../src/cli/veyra-account.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { main } from "../src/main.ts";

let tempDir: string;
let agentDir: string;
let stdout: string[];
let stderr: string[];
let originalAgentDir: string | undefined;
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "fingers-veyra-dispatch-"));
	agentDir = join(tempDir, "agent");
	originalAgentDir = process.env[ENV_AGENT_DIR];
	originalExitCode = process.exitCode;
	process.env[ENV_AGENT_DIR] = agentDir;
	process.exitCode = undefined;
	stdout = [];
	stderr = [];
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdout.push(String(chunk));
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
	vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
		stdout.push(`${parts.join(" ")}\n`);
	});
	vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
		stderr.push(`${parts.join(" ")}\n`);
	});
	vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
		throw new Error(`process.exit(${code}) during an account command`);
	}) as typeof process.exit);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = originalExitCode;
	if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = originalAgentDir;
	rmSync(tempDir, { recursive: true, force: true });
});

describe("main() dispatch of the Veyra account commands", () => {
	it("fingers whoami runs the account command: not signed in, exit 1", async () => {
		await main(["whoami"]);
		expect(stdout.join("")).toBe("Not signed in to Veyra. Run fingers login.\n");
		expect(process.exitCode).toBe(1);
	});

	it("fingers logout runs the account command: nothing to sign out of, exit 0", async () => {
		await main(["logout"]);
		expect(stdout.join("")).toBe("Not signed in to Veyra.\n");
		expect(process.exitCode).toBe(0);
	});

	it("fingers login runs the account command, not a session whose first message is 'login'", async () => {
		await main(["login"]);
		// The sign-in refuses to run without the OS keychain (FINGERS_CREDENTIAL_STORE=file here) before any request.
		expect(stderr.join("")).toContain("keeps your Veyra sign-in only in the OS keychain");
		expect(process.exitCode).toBe(1);
		// No session was started or written.
		expect(existsSync(join(agentDir, "sessions"))).toBe(false);
	});

	it("fingers login --help prints the account commands' help", async () => {
		await main(["login", "--help"]);
		const text = stdout.join("");
		expect(text).toContain("fingers login [--no-browser] [--connect <url>]");
		expect(text).toContain("fingers whoami [--json] [--connect <url>]");
		expect(text).toContain("fingers logout [--connect <url>]");
		expect(process.exitCode).toBe(0);
	});
});

describe("isVeyraAccountCommand (the predicate main() dispatches on)", () => {
	it("is the first argument exactly login, logout or whoami", () => {
		expect(isVeyraAccountCommand(["login"])).toBe(true);
		expect(isVeyraAccountCommand(["logout", "--connect", "https://connect.veyra.localhost"])).toBe(true);
		expect(isVeyraAccountCommand(["whoami", "--json"])).toBe(true);
	});

	it("a first message that only starts with the word, or a later argument, still starts a session", () => {
		expect(isVeyraAccountCommand(["login to the staging box and check the logs"])).toBe(false);
		expect(isVeyraAccountCommand(["--print", "login"])).toBe(false);
		expect(isVeyraAccountCommand(["-c", "whoami"])).toBe(false);
		expect(isVeyraAccountCommand(["auth", "login"])).toBe(false);
		expect(isVeyraAccountCommand([])).toBe(false);
	});
});
