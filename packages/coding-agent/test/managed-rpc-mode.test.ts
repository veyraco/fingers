/**
 * Managed RPC mode behaviour beyond the golden transcripts: handshake errors, secrets that a provider echoes,
 * the path policy through the whole stack, abort during an approval, limits and the CLI flag.
 */
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { validateOutbound } from "../src/modes/rpc/managed/contract.ts";
import { ManagedRpcServer } from "../src/modes/rpc/managed/managed-rpc-server.ts";
import { createManagedRuntimeFactory } from "../src/modes/rpc/managed/managed-runtime.ts";
import { listen, type ScriptedResponse, startFakeAnthropic } from "./managed-rpc-fakes.ts";

type Rec = Record<string, any>;

const TOKEN = "hpt_run_test_q8Zr3vK1xYwT0b";
const TRACE = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba90200-01";
const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllEnvs();
});

function filesUnder(dir: string): string[] {
	let files: string[] = [];
	try {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			files = statSync(path).isDirectory() ? files.concat(filesUnder(path)) : files.concat(path);
		}
	} catch {
		// Missing directory: no files.
	}
	return files;
}

async function startManaged(responses: ScriptedResponse[]) {
	vi.stubEnv("ANTHROPIC_API_KEY", "");
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fingers-managed-")));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "workspace");
	mkdirSync(workspace);
	mkdirSync(join(root, "private"));
	writeFileSync(join(root, "private", "secret.txt"), "runner state");
	const anthropic = startFakeAnthropic(responses);
	const anthropicUrl = await listen(anthropic.server);
	cleanups.push(() => new Promise<void>((resolve) => anthropic.server.close(() => resolve())));
	const outs: Rec[] = [];
	const stderr: string[] = [];
	const invalidStdout: string[] = [];
	const server = new ManagedRpcServer({
		io: {
			writeStdout: (line) => {
				try {
					outs.push(JSON.parse(line));
				} catch {
					invalidStdout.push(line);
				}
			},
			writeStderr: (line) => stderr.push(line),
		},
		createRuntime: createManagedRuntimeFactory({ agentDir: join(root, "agent"), sessionDir: join(root, "sessions") }),
		version: "0.1.0",
		env: "test",
	});
	cleanups.push(() => server.shutdown("test end"));
	server.start();
	let n = 0;
	// Commands carry a traceparent; replies to Fingers' requests do not (their schema has no such field).
	const send = (record: Rec) =>
		server.handleLine(JSON.stringify(record.type.endsWith("_response") ? record : { traceparent: TRACE, ...record }));
	const command = async (record: Rec): Promise<Rec> => {
		const id = record.id ?? `c${++n}`;
		await send({ ...record, id });
		await vi.waitFor(() => expect(outs.some((out) => out.type === "response" && out.id === id)).toBe(true), {
			timeout: 10_000,
			interval: 10,
		});
		return outs.find((out) => out.type === "response" && out.id === id)!;
	};
	const configure = (extra: Rec = {}) =>
		command({
			type: "configure",
			run_id: "run_test",
			request_id: "req_test",
			workspace: { root: workspace, protected_paths: [join(root, "private")] },
			model: { provider: "anthropic", model_id: "claude-sonnet-4-5" },
			...extra,
		});
	const credentials = (extra: Rec = {}) =>
		command({
			type: "credentials",
			provider: "anthropic",
			base_url: anthropicUrl,
			credential_kind: "proxy_token",
			credential: TOKEN,
			expires_at: new Date(Date.now() + 3_600_000).toISOString(),
			...extra,
		});
	const waitFor = async (type: string, count = 1) => {
		await vi.waitFor(() => expect(outs.filter((out) => out.type === type).length).toBeGreaterThanOrEqual(count), {
			timeout: 15_000,
			interval: 10,
		});
		return outs.filter((out) => out.type === type);
	};
	return {
		root,
		workspace,
		server,
		outs,
		stderr,
		invalidStdout,
		send,
		command,
		configure,
		credentials,
		waitFor,
		anthropic,
	};
}

describe("managed RPC handshake", () => {
	it("answers hello first and enforces configure, credentials and command errors", async () => {
		const m = await startManaged([]);
		expect(m.outs[0]).toMatchObject({ type: "hello", seq: 1, protocol: "veyra.fingers.rpc.v1", managed: true });

		await m.server.handleLine("{not json");
		expect(m.outs.at(-1)).toEqual({
			type: "response",
			command: "parse",
			success: false,
			error: expect.any(String),
			code: "parse_error",
		});
		expect(await m.command({ type: "get_state" })).toMatchObject({ success: false, code: "not_configured" });
		expect(await m.command({ type: "bash", command: "ls" })).toMatchObject({
			success: false,
			code: "unknown_command",
		});
		expect(await m.command({ type: "prompt", message: "" })).toMatchObject({
			success: false,
			code: "invalid_command",
		});

		expect(await m.configure()).toMatchObject({ success: true, data: { session_id: expect.any(String) } });
		expect(await m.configure()).toMatchObject({ success: false, code: "already_configured" });
		expect(await m.command({ type: "prompt", message: "hi" })).toMatchObject({
			success: false,
			code: "credentials_missing",
		});
		// No checkpoints.dir configured: nowhere a checkpoint may be written.
		expect(await m.command({ type: "checkpoint_export", path: join(m.root, "cp.jsonl") })).toMatchObject({
			success: false,
			code: "path_not_allowed",
		});
		for (const out of m.outs) expect(validateOutbound(out), JSON.stringify(out)).toEqual([]);
	});

	it("refuses a workspace inside a protected path and an unknown model", async () => {
		const m = await startManaged([]);
		expect(
			await m.command({
				type: "configure",
				workspace: { root: m.workspace, protected_paths: [m.root] },
				model: { provider: "anthropic", model_id: "claude-sonnet-4-5" },
			}),
		).toMatchObject({ success: false, code: "invalid_command", error: expect.stringContaining("protected") });
		expect(
			await m.command({
				type: "configure",
				workspace: { root: m.workspace },
				model: { provider: "anthropic", model_id: "no-such-model" },
			}),
		).toMatchObject({ success: false, code: "invalid_command", error: expect.stringContaining("Unknown model") });
		// A failed configure can be retried.
		expect(await m.configure()).toMatchObject({ success: true });
	});

	it("logs a warning for a command without traceparent and continues the given trace otherwise", async () => {
		const m = await startManaged([]);
		await m.server.handleLine(JSON.stringify({ id: "x", type: "get_state" }));
		await m.configure();
		const logs = m.stderr.map((line) => JSON.parse(line));
		expect(logs.some((log) => log.level === "warn" && /traceparent/.test(log.msg))).toBe(true);
		expect(logs.find((log) => log.msg === "configured")).toMatchObject({
			trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
			run_id: "run_test",
			request_id: "req_test",
		});
	});
});

describe("managed RPC correlation on model requests", () => {
	const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
	const header = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join(",") : value);

	it("sends a child traceparent of the command's trace and the run's X-Request-Id on every model request", async () => {
		const m = await startManaged([
			{ content: [{ type: "toolCall", id: "toolu_l", name: "ls", arguments: {} }], usage, stopReason: "toolUse" },
			{ content: [{ type: "text", text: "Done." }], usage, stopReason: "stop" },
		]);
		await m.configure({ tools: { builtin: ["read", "ls"], approval: "never" } });
		await m.credentials();
		await m.command({ type: "prompt", message: "look around" });
		await m.waitFor("result");
		expect(m.anthropic.requests).toHaveLength(2);
		const spans = m.anthropic.requests.map((request) => {
			const traceparent = header(request.headers.traceparent) ?? "";
			const match = traceparent.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/);
			expect(match, `traceparent ${traceparent}`).not.toBeNull();
			expect(match![1]).toBe(TRACE_ID);
			expect(header(request.headers["x-request-id"])).toBe("req_test");
			return match![2];
		});
		// Each model request is a new child span, never the host's span itself.
		expect(new Set(spans).size).toBe(2);
		expect(spans).not.toContain("00f067aa0ba90200");
	});

	it("keeps the trace of the command that started the run; a new run takes its own command's trace", async () => {
		const TRACE_B = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
		const TRACE_C = "00-11111111111111111111111111111111-2222222222222222-00";
		const m = await startManaged([
			{
				content: [{ type: "toolCall", id: "toolu_w", name: "write", arguments: { path: "a.txt", content: "a" } }],
				usage,
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "Written." }], usage, stopReason: "stop" },
			{ content: [{ type: "text", text: "Second run." }], usage, stopReason: "stop" },
		]);
		await m.configure({ tools: { approval: "write_tools" } });
		await m.credentials();
		await m.command({ type: "prompt", message: "write a" });
		const [request] = await m.waitFor("approval_request");
		// A command that starts no work, sent mid-run, does not move the run's model requests to its trace.
		await m.command({ type: "get_state", traceparent: TRACE_C });
		await m.send({ type: "approval_response", id: request.id, decision: "allow_once" });
		await m.waitFor("result");
		await m.command({ type: "prompt", message: "again", traceparent: TRACE_B });
		await m.waitFor("result", 2);
		const traces = m.anthropic.requests.map((r) => header(r.headers.traceparent)?.split("-")[1]);
		expect(traces).toEqual([TRACE_ID, TRACE_ID, "0af7651916cd43dd8448eb211c80319c"]);
	});
});

describe("managed RPC secrets", () => {
	it("keeps a credential the provider echoes out of stdout, logs and session files", async () => {
		const m = await startManaged([
			{
				content: [],
				usage,
				stopReason: "error",
				error: {
					status: 401,
					body: JSON.stringify({
						type: "error",
						error: { type: "authentication_error", message: `invalid key ${TOKEN}` },
					}),
				},
			},
		]);
		await m.configure();
		await m.credentials();
		await m.command({ type: "prompt", message: "hello" });
		const [result] = await m.waitFor("result");
		expect(result).toMatchObject({ status: "failed", stop_reason: "model_error", failure: { code: "model_error" } });
		// The echo really happened: the error text reached Fingers.
		expect(JSON.stringify(m.outs)).toContain("invalid key [redacted]");
		const sessionFiles = filesUnder(join(m.root, "sessions"));
		expect(sessionFiles.length).toBeGreaterThan(0);
		const persisted = sessionFiles.map((file) => readFileSync(file, "utf8")).join("\n");
		expect(persisted).toContain("invalid key");
		expect(persisted).not.toContain(TOKEN);
		expect(JSON.stringify(m.outs)).not.toContain(TOKEN);
		expect(m.stderr.join("")).not.toContain(TOKEN);
		expect(
			filesUnder(join(m.root, "agent"))
				.map((file) => readFileSync(file, "utf8"))
				.join(""),
		).not.toContain(TOKEN);
	});
});

describe("managed RPC secret scrubbing keeps records valid", () => {
	const HEADERS = {
		"x-flag": "true",
		"anthropic-version": "2023-06-01",
		"x-api-key-extra": "short",
		"x-conformance-secret": "header-secret-value",
		"proxy-authorization": "Bearer abcdefghijklmnop",
	};

	it("answers credentials with short non-secret header values as valid JSON", async () => {
		const m = await startManaged([]);
		expect(await m.configure()).toMatchObject({ success: true });
		const response = await m.credentials({ headers: HEADERS });
		expect(response).toMatchObject({ type: "response", command: "credentials", success: true });
		expect(m.invalidStdout).toEqual([]);
		expect(await m.command({ type: "get_state" })).toMatchObject({ success: true });
		expect(m.invalidStdout).toEqual([]);
	});

	it("still redacts the credential and credential-named header values a provider echoes", async () => {
		const m = await startManaged([
			{
				content: [],
				usage,
				stopReason: "error",
				error: {
					status: 400,
					body: JSON.stringify({
						type: "error",
						error: {
							type: "invalid_request_error",
							message: `bad ${TOKEN} / header-secret-value / Bearer abcdefghijklmnop / flag true / 2023-06-01`,
						},
					}),
				},
			},
		]);
		await m.configure();
		await m.credentials({ headers: HEADERS });
		await m.command({ type: "prompt", message: "hello" });
		await m.waitFor("result");
		expect(m.invalidStdout).toEqual([]);
		const stdout = JSON.stringify(m.outs);
		// The echo reached Fingers; only the secrets were replaced, the plain header values stay readable.
		expect(stdout).toContain("bad [redacted] / [redacted] / [redacted] / flag true / 2023-06-01");
		for (const secret of [TOKEN, "header-secret-value", "Bearer abcdefghijklmnop"]) {
			expect(stdout).not.toContain(secret);
			expect(m.stderr.join("")).not.toContain(secret);
		}
		// Every header still went to the provider.
		const sent = m.anthropic.requests[0]!.headers;
		expect(sent["x-flag"]).toBe("true");
		expect(sent["x-conformance-secret"]).toBe("header-secret-value");
	});
});

describe("managed RPC policy through the stack", () => {
	it("blocks a write outside the workspace before asking for approval", async () => {
		const m = await startManaged([
			{
				content: [
					{
						type: "toolCall",
						id: "toolu_w",
						name: "write",
						arguments: { path: "../private/secret.txt", content: "x" },
					},
				],
				usage,
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "Could not write." }], usage, stopReason: "stop" },
		]);
		await m.configure({ tools: { approval: "always" } });
		await m.credentials();
		await m.command({ type: "prompt", message: "overwrite the runner state" });
		await m.waitFor("result");
		expect(m.outs.some((out) => out.type === "approval_request")).toBe(false);
		const end = m.outs.find((out) => out.type === "tool_execution_end")!;
		expect(end).toMatchObject({ toolCallId: "toolu_w", isError: true });
		expect(end.result.content[0].text).toMatch(/protected|outside/);
		expect(readFileSync(join(m.root, "private", "secret.txt"), "utf8")).toBe("runner state");
		expect(m.outs.some((out) => out.type === "file_changed")).toBe(false);
	});

	it("an abort while an approval is pending cancels it and ends the run as cancelled", async () => {
		const m = await startManaged([
			{
				content: [{ type: "toolCall", id: "toolu_b", name: "bash", arguments: { command: "rm -rf build" } }],
				usage,
				stopReason: "toolUse",
			},
		]);
		await m.configure({ tools: { approval: "write_tools" } });
		await m.credentials();
		await m.command({ type: "prompt", message: "clean up" });
		const [request] = await m.waitFor("approval_request");
		expect(request).toMatchObject({ kind: "command", tool: { server: "builtin", name: "bash" } });
		await m.command({ type: "abort" });
		const [result] = await m.waitFor("result");
		expect(m.outs.find((out) => out.type === "approval_resolved")).toMatchObject({
			id: request.id,
			decision: "cancelled",
		});
		expect(m.outs.find((out) => out.type === "agent_settled")).toMatchObject({ aborted: true });
		expect(result).toMatchObject({
			status: "cancelled",
			stop_reason: "aborted",
			failure: { code: "cancelled_by_actor" },
		});
		// A late answer is ignored with a warning.
		await m.send({ type: "approval_response", id: request.id, decision: "allow_once" });
		expect(m.stderr.some((line) => line.includes("approval response ignored"))).toBe(true);
	});

	it("applies edited arguments from an approval and records who decided", async () => {
		const m = await startManaged([
			{
				content: [
					{ type: "toolCall", id: "toolu_e", name: "write", arguments: { path: "a.txt", content: "one\n" } },
				],
				usage,
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "Done." }], usage, stopReason: "stop" },
		]);
		await m.configure({ tools: { approval: "write_tools" } });
		await m.credentials();
		await m.command({ type: "prompt", message: "write a" });
		const [request] = await m.waitFor("approval_request");
		await m.send({
			type: "approval_response",
			id: request.id,
			decision: "allow_once",
			edited_arguments: { path: "b.txt", content: "two\n" },
			decided_by: { type: "person", id: "usr_1" },
		});
		await m.waitFor("result");
		expect(readFileSync(join(m.workspace, "b.txt"), "utf8")).toBe("two\n");
		expect(m.outs.find((out) => out.type === "file_changed")).toMatchObject({
			path: "b.txt",
			change: "added",
			additions: 1,
		});
		const persisted = filesUnder(join(m.root, "sessions"))
			.map((file) => readFileSync(file, "utf8"))
			.join("\n");
		expect(persisted).toContain('"customType":"veyra.approval"');
		expect(persisted).toContain('"usr_1"');
	});
});

describe("managed RPC limits", () => {
	it("max_turns stops the run with agent_error after the turn", async () => {
		const call = (id: string): ScriptedResponse => ({
			content: [{ type: "toolCall", id, name: "ls", arguments: {} }],
			usage,
			stopReason: "toolUse",
		});
		const m = await startManaged([call("t1"), call("t2"), call("t3")]);
		await m.configure({ limits: { max_turns: 2 }, tools: { builtin: ["read", "ls"], approval: "never" } });
		await m.credentials();
		await m.command({ type: "prompt", message: "look around" });
		const [result] = await m.waitFor("result");
		expect(m.anthropic.requests).toHaveLength(2);
		expect(result).toMatchObject({
			status: "stopped",
			stop_reason: "max_turns_reached",
			failure: { code: "agent_error" },
			turns: 2,
		});
		expect(m.outs.find((out) => out.type === "notice")).toMatchObject({ code: "limit_reached" });
		expect(m.outs.find((out) => out.type === "agent_settled")).toMatchObject({ aborted: true });
	});

	it("reports cost_unknown once for a model without a list price", async () => {
		const m = await startManaged([{ content: [{ type: "text", text: "hi" }], usage, stopReason: "stop" }]);
		await m.configure({ limits: { max_cost_usd: 1 } });
		await m.credentials();
		m.server.currentSession!.modelRuntime.getModel("anthropic", "claude-sonnet-4-5")!.cost.input = 0;
		const model = m.server.currentSession!.model!;
		model.cost.input = 0;
		model.cost.output = 0;
		await m.command({ type: "prompt", message: "hi" });
		await m.waitFor("result");
		expect(m.outs.find((out) => out.type === "usage")).toMatchObject({ cost_source: "unknown" });
		expect(m.outs.filter((out) => out.type === "notice").map((out) => out.code)).toEqual(["cost_unknown"]);
	});
});

describe("CLI", () => {
	it("parses --managed", () => {
		expect(parseArgs(["--mode", "rpc", "--managed"])).toMatchObject({ mode: "rpc", managed: true });
		expect(parseArgs(["--mode", "rpc"]).managed).toBeUndefined();
	});
});
