/**
 * `fingers --mode rpc --managed` as a real process: hello on stdout, JSON logs on stderr, configure and
 * credentials over stdin, an orderly exit when stdin closes, and no network traffic of its own.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NETWORK_SPY = `
import { appendFileSync } from "node:fs";
import net from "node:net";
const log = process.env.FINGERS_TEST_NETWORK_LOG;
const record = (kind, target) => appendFileSync(log, JSON.stringify({ kind, target }) + "\\n");
globalThis.fetch = async (input) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	record("fetch", url);
	throw new TypeError("fetch failed (blocked by the managed process test)");
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
	const first = Array.isArray(args[0]) ? args[0][0] : args[0];
	if (first && typeof first === "object" && first.path === undefined) {
		record("connect", String(first.host ?? "localhost") + ":" + String(first.port));
	} else if (typeof first === "number") {
		record("connect", String(args[1] ?? "localhost") + ":" + String(first));
	}
	return connect.apply(this, args);
};
`;

function prepare() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fingers-managed-process-")));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const workspace = join(root, "workspace");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(workspace, { recursive: true });
	const spyPath = join(root, "network-spy.mjs");
	writeFileSync(spyPath, NETWORK_SPY);
	const env = {
		PATH: process.env.PATH ?? "",
		HOME: root,
		USERPROFILE: root,
		TMPDIR: tmpdir(),
		[ENV_AGENT_DIR]: agentDir,
		FINGERS_TEST_NETWORK_LOG: join(root, "network.log"),
		FINGERS_ENV: "test",
	};
	return { root, workspace, env, spyUrl: pathToFileURL(spyPath).href, logPath: join(root, "network.log") };
}

describe("fingers --mode rpc --managed", () => {
	it("speaks the handshake, logs JSON to stderr, exits 0 when stdin closes and makes no request", async () => {
		const { workspace, env, spyUrl, logPath } = prepare();
		const child = spawn(
			process.execPath,
			["--import", sourceResolverUrl, "--import", spyUrl, cliPath, "--mode", "rpc", "--managed"],
			{ cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const exited = new Promise<number | null>((resolveExit, reject) => {
			child.on("error", reject);
			child.on("close", (code) => resolveExit(code));
		});
		const waitForLine = (needle: string) =>
			new Promise<void>((resolveLine, reject) => {
				const check = () => {
					if (stdout.includes(needle)) {
						child.stdout.off("data", onData);
						resolveLine();
					}
				};
				const onData = (chunk: Buffer) => {
					stdout += chunk.toString();
					check();
				};
				child.stdout.on("data", onData);
				child.once("close", () => reject(new Error(`exited early. stderr:\n${stderr}`)));
				check();
			});
		const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba90200-01";
		await waitForLine('"type":"hello"');
		child.stdin.write(
			`${JSON.stringify({
				id: "c1",
				type: "configure",
				run_id: "run_proc",
				request_id: "req_proc",
				traceparent,
				workspace: { root: workspace },
				model: { provider: "anthropic", model_id: "claude-sonnet-4-5" },
			})}\n`,
		);
		await waitForLine('"id":"c1"');
		child.stdin.write(
			`${JSON.stringify({
				id: "c2",
				type: "credentials",
				traceparent,
				provider: "anthropic",
				base_url: "http://127.0.0.1:9",
				credential_kind: "proxy_token",
				credential: "hpt_process_secret_value",
			})}\n`,
		);
		await waitForLine('"id":"c2"');
		child.stdin.write(`${JSON.stringify({ id: "c3", type: "get_state", traceparent })}\n`);
		await waitForLine('"id":"c3"');
		child.stdin.end();
		expect(await exited).toBe(0);

		const records = stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(records[0]).toMatchObject({ type: "hello", seq: 1, managed: true, fingers_version: expect.any(String) });
		expect(records.find((record) => record.id === "c1")).toMatchObject({
			success: true,
			data: { session_id: expect.any(String) },
		});
		expect(records.find((record) => record.id === "c2")).toMatchObject({
			success: true,
			data: { provider: "anthropic" },
		});
		expect(records.find((record) => record.id === "c3")).toMatchObject({ success: true });
		expect(stdout).not.toContain("hpt_process_secret_value");
		const logs = stderr
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(logs.find((log) => log.msg === "configured")).toMatchObject({
			service: "fingers",
			env: "test",
			run_id: "run_proc",
			trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
		});
		expect(stderr).not.toContain("hpt_process_secret_value");
		expect(existsSync(logPath) ? readFileSync(logPath, "utf8") : "").toBe("");
	}, 60_000);

	it("refuses --managed without --mode rpc", () => {
		const { workspace, env } = prepare();
		const result = spawnSync(process.execPath, ["--import", sourceResolverUrl, cliPath, "--managed", "-p", "hi"], {
			cwd: workspace,
			env,
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("--managed requires --mode rpc");
	}, 60_000);
});
