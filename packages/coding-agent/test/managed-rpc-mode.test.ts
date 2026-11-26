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
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { validateOutbound } from "../src/modes/rpc/managed/contract.ts";
import { ManagedRpcServer } from "../src/modes/rpc/managed/managed-rpc-server.ts";
import { createManagedRuntimeFactory } from "../src/modes/rpc/managed/managed-runtime.ts";
import { listen, type ScriptedResponse, startFakeAnthropic, startFakeMcp } from "./managed-rpc-fakes.ts";

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

describe("managed RPC MCP server headers (F6b)", () => {
	const MCP_SECRET = "Bearer hrt_mcp_run_token_7Qx2Lp9z";

	it("sends configure.mcp_servers[].headers to the MCP server and keeps their values out of stdout, logs and session files", async () => {
		const mcp = startFakeMcp({ echoAuthorization: true });
		const mcpUrl = await listen(mcp.server);
		cleanups.push(() => new Promise<void>((resolve) => mcp.server.close(() => resolve())));
		const m = await startManaged([
			{
				content: [
					{
						type: "toolCall",
						id: "toolu_m",
						name: "mcp__github__create_pull_request",
						arguments: { title: "t", head: "h", base: "main" },
					},
				],
				usage,
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "Opened." }], usage, stopReason: "stop" },
		]);
		const configured = await m.configure({
			tools: { approval: "never" },
			mcp_servers: [
				{
					name: "github",
					url: `${mcpUrl}/mcp`,
					headers: { Authorization: MCP_SECRET, "x-flag": "true" },
					allowed_tools: ["create_pull_request"],
					approval: "never",
				},
			],
		});
		expect(configured).toMatchObject({ success: true });
		await m.credentials();
		await m.command({ type: "prompt", message: "open a pull request" });
		const [result] = await m.waitFor("result");
		expect(result).toMatchObject({ status: "completed" });
		// The header reached the MCP server on every request, and the tool really ran.
		expect(mcp.authorizations.length).toBeGreaterThan(0);
		expect(mcp.authorizations.every((value) => value === MCP_SECRET)).toBe(true);
		expect(mcp.calls).toHaveLength(1);
		// The server echoed the value into its tool result; Fingers passed the result on with the value redacted.
		expect(m.invalidStdout).toEqual([]);
		const stdout = JSON.stringify(m.outs);
		expect(stdout).toContain("created with [redacted]");
		expect(JSON.stringify(m.anthropic.requests[1]!.body.messages)).toContain("created with");
		expect(stdout).not.toContain(MCP_SECRET);
		expect(stdout).not.toContain("hrt_mcp_run_token_7Qx2Lp9z");
		const stderr = m.stderr.join("");
		expect(stderr.length).toBeGreaterThan(0);
		expect(stderr).not.toContain("hrt_mcp_run_token_7Qx2Lp9z");
		const sessionFiles = filesUnder(join(m.root, "sessions"));
		expect(sessionFiles.length).toBeGreaterThan(0);
		const persisted = sessionFiles
			.concat(filesUnder(join(m.root, "agent")))
			.map((file) => readFileSync(file, "utf8"))
			.join("\n");
		expect(persisted).toContain("created with");
		expect(persisted).not.toContain("hrt_mcp_run_token_7Qx2Lp9z");
		// The configured log line names the server, never its headers.
		const configuredLog = m.stderr.map((line) => JSON.parse(line) as Rec).find((log) => log.msg === "configured");
		expect(configuredLog).toMatchObject({ mcp_servers: ["github"] });
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

describe("managed RPC configure.system_prompt (F6c)", () => {
	const INSTRUCTIONS = "You are the release engineer of Acme. Answer in haiku and sign every reply with ACME-REL-7.";
	/** The system prompt text of one Anthropic request (`system` is a string or text blocks). */
	const systemText = (request: { body: Rec }): string =>
		typeof request.body.system === "string"
			? request.body.system
			: ((request.body.system ?? []) as Rec[]).map((block) => block.text).join("\n");
	const userText = (request: { body: Rec }): string => JSON.stringify(request.body.messages);

	it("sends the host's instructions as the system prompt of every model request, after Fingers' own prompt", async () => {
		const m = await startManaged([
			{ content: [{ type: "toolCall", id: "toolu_l", name: "ls", arguments: {} }], usage, stopReason: "toolUse" },
			{ content: [{ type: "text", text: "Done." }], usage, stopReason: "stop" },
		]);
		const configured = await m.configure({
			system_prompt: INSTRUCTIONS,
			tools: { builtin: ["read", "ls"], approval: "never" },
		});
		expect(configured, JSON.stringify(configured)).toMatchObject({ success: true });
		await m.credentials();
		await m.command({ type: "prompt", message: "look around" });
		const [result] = await m.waitFor("result");
		expect(result).toMatchObject({ status: "completed" });
		expect(m.anthropic.requests).toHaveLength(2);
		for (const request of m.anthropic.requests) {
			const system = systemText(request);
			expect(system).toContain(INSTRUCTIONS);
			// Fingers' own prompt (identity, tools, rules) stays and comes first.
			expect(system).toContain("running inside fingers");
			expect(system.indexOf("running inside fingers")).toBeLessThan(system.indexOf(INSTRUCTIONS));
			// Never in a user message.
			expect(userText(request)).not.toContain(INSTRUCTIONS);
		}
		expect(userText(m.anthropic.requests[0]!)).toContain("look around");
		// Logged by size only, never by content.
		expect(m.stderr.join("")).not.toContain("ACME-REL-7");
		const configuredLog = m.stderr.map((line) => JSON.parse(line)).find((line) => line.msg === "configured");
		expect(configuredLog).toMatchObject({ system_prompt_chars: INSTRUCTIONS.length });
		for (const out of m.outs) expect(validateOutbound(out), JSON.stringify(out)).toEqual([]);
	});

	it("uses the text verbatim, never as a file path", async () => {
		const m = await startManaged([{ content: [{ type: "text", text: "ok" }], usage, stopReason: "stop" }]);
		// A path to a file that exists (and is protected): its content must not reach the model.
		const path = join(m.root, "private", "secret.txt");
		await m.configure({ system_prompt: path });
		await m.credentials();
		await m.command({ type: "prompt", message: "hi" });
		await m.waitFor("result");
		const system = systemText(m.anthropic.requests[0]!);
		expect(system).toContain(path);
		expect(system).not.toContain("runner state");
	});

	it("without system_prompt, or with an empty one, sends Fingers' own system prompt only", async () => {
		const prompts: string[] = [];
		for (const extra of [{}, { system_prompt: "" }]) {
			const m = await startManaged([{ content: [{ type: "text", text: "ok" }], usage, stopReason: "stop" }]);
			await m.configure(extra);
			await m.credentials();
			await m.command({ type: "prompt", message: "hi" });
			await m.waitFor("result");
			prompts.push(systemText(m.anthropic.requests[0]!).replaceAll(m.root, "<root>"));
			expect(prompts.at(-1)).toContain("running inside fingers");
			expect(prompts.at(-1)).not.toContain("<addendum>");
		}
		expect(prompts[1]).toBe(prompts[0]);
	});

	it("fails configure when system_prompt is not text or too long", async () => {
		for (const system_prompt of [["one", "two"], "x".repeat(200_001)]) {
			const m = await startManaged([]);
			const response = await m.configure({ system_prompt });
			expect(response).toMatchObject({ success: false, code: "invalid_command" });
			expect(m.anthropic.requests).toHaveLength(0);
		}
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

describe("managed RPC memory relay", () => {
	const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
	const text = (value: string): ScriptedResponse => ({
		content: [{ type: "text", text: value }],
		usage,
		stopReason: "stop",
	});

	it("announces the relay and, with memory off, sends no memory request and offers no memory tools", async () => {
		const m = await startManaged([text("ok")]);
		expect(m.outs[0]!.capabilities).toContain("memory_relay");
		await m.configure();
		await m.credentials();
		await m.command({ type: "prompt", message: "hi" });
		await m.waitFor("result");
		expect(m.outs.filter((out) => out.type === "memory_request")).toEqual([]);
		const tools = (m.anthropic.requests[0]!.body.tools as Rec[]).map((tool) => tool.name);
		expect(tools).not.toContain("memory_recall");
		expect(JSON.stringify(m.anthropic.requests[0]!.body.system)).not.toContain("<memory>");
	});

	it("relays recall and remember to the host, ignores stray replies, and says once that memory is unavailable", async () => {
		const m = await startManaged([
			{
				content: [{ type: "toolCall", id: "toolu_r", name: "memory_recall", arguments: { query: "flaky tests" } }],
				usage,
				stopReason: "toolUse",
			},
			{
				content: [
					{ type: "toolCall", id: "toolu_m", name: "memory_remember", arguments: { text: "Use STRIPE_FAKE=1." } },
				],
				usage,
				stopReason: "toolUse",
			},
			text("done"),
			text("again"),
		]);
		await m.configure({ memory: { mode: "relay", context_budget_tokens: 500 } });
		await m.credentials();
		// The host answers every request: context with nothing, recall with one item, remember with an id; the
		// learning events fail.
		const answered = new Set<string>();
		const answer = async () => {
			for (const request of m.outs.filter((out) => out.type === "memory_request")) {
				if (answered.has(request.id)) continue;
				answered.add(request.id);
				if (request.op === "events") {
					await m.send({
						type: "memory_response",
						id: request.id,
						ok: false,
						error: { code: "unavailable", message: "Brain is down" },
					});
				} else {
					const data =
						request.op === "context"
							? { context: "", tokens: 0, items: [] }
							: request.op === "recall"
								? {
										data: [
											{
												ref: "lt_1 v1",
												kind: "fact",
												text: "The checkout suite is flaky on CI.",
												score: 0.8,
											},
										],
									}
								: { id: "lt_7", space_id: "sp_x", type: "fact", text: "Use STRIPE_FAKE=1." };
					await m.send({ type: "memory_response", id: request.id, ok: true, data });
				}
			}
		};
		const timer = setInterval(() => void answer(), 5);
		cleanups.push(() => clearInterval(timer));

		await m.command({ type: "prompt", message: "Fix the flaky checkout test." });
		await m.waitFor("result");
		await m.command({ type: "prompt", message: "And the other one." });
		await m.waitFor("result", 2);

		const requests = m.outs.filter((out) => out.type === "memory_request");
		expect(requests.map((request) => request.op)).toEqual(["context", "recall", "remember", "events", "events"]);
		expect(requests[0]!.body).toMatchObject({ task: "Fix the flaky checkout test.", max_tokens: 500 });
		expect(requests[1]!.body).toEqual({ query: "flaky tests", limit: 8 });
		expect(requests[2]!.body).toEqual({
			type: "fact",
			text: "Use STRIPE_FAKE=1.",
			refs: [{ app: "hands", type: "run", id: "run_test" }],
		});
		// The tool results reached the model.
		expect(JSON.stringify(m.anthropic.requests[1]!.body.messages)).toContain("The checkout suite is flaky on CI.");
		expect(JSON.stringify(m.anthropic.requests[2]!.body.messages)).toContain("Saved to memory as lt_7.");
		// Two failed event reports, one notice for the run.
		expect(m.outs.filter((out) => out.type === "notice" && out.code === "memory_unavailable")).toHaveLength(1);
		expect(m.outs.filter((out) => out.type === "result").map((out) => out.status)).toEqual([
			"completed",
			"completed",
		]);

		// Replies the relay is not waiting for, or that break the contract, change nothing.
		await m.send({ type: "memory_response", id: requests[0]!.id, ok: true, data: { context: "late" } });
		await m.send({ type: "memory_response", id: "memreq_999", ok: true, data: {} });
		await m.send({ type: "memory_response", id: "memreq_1", ok: true });
		const logs = m.stderr.map((line) => JSON.parse(line) as Rec);
		expect(logs.filter((log) => log.msg === "memory_response for no waiting request ignored")).toHaveLength(2);
		expect(logs.filter((log) => log.msg === "invalid memory_response ignored")).toHaveLength(1);
		expect(logs.filter((log) => log.msg === "memory unavailable; continuing without it")).toHaveLength(2);
		for (const out of m.outs) expect(validateOutbound(out), JSON.stringify(out)).toEqual([]);
	});
});

describe("managed RPC telemetry relay (F21)", () => {
	const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
	const spansOf = (outs: Rec[]) => outs.filter((out) => out.type === "telemetry_span").map((out) => out.span as Rec);

	it("announces telemetry_relay and sends no span with telemetry off (the default)", async () => {
		const m = await startManaged([{ content: [{ type: "text", text: "ok" }], usage, stopReason: "stop" }]);
		expect(m.outs[0]!.capabilities).toContain("telemetry_relay");
		await m.configure();
		await m.credentials();
		await m.command({ type: "prompt", message: "hi" });
		await m.waitFor("result");
		expect(spansOf(m.outs)).toEqual([]);
		const logs = m.stderr.map((line) => JSON.parse(line) as Rec);
		expect(logs.find((log) => log.msg === "configured")).toMatchObject({ telemetry_mode: "off" });
	});

	it("relays a chat span per model call and an execute_tool span per tool call, on the run's trace", async () => {
		const fetched: string[] = [];
		const realFetch = globalThis.fetch;
		vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			fetched.push(String(input instanceof Request ? input.url : input));
			return realFetch(input, init);
		});
		cleanups.push(() => vi.unstubAllGlobals());
		const m = await startManaged([
			{
				content: [{ type: "toolCall", id: "toolu_ls", name: "ls", arguments: {} }],
				usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 0 },
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "Empty." }], usage, stopReason: "stop" },
		]);
		await m.configure({ tools: { builtin: ["ls"], approval: "never" }, telemetry: { mode: "relay" } });
		await m.credentials();
		await m.command({ type: "prompt", message: "look around" });
		await m.waitFor("result");
		const spans = spansOf(m.outs);
		expect(spans.map((span) => span.name)).toEqual([
			"chat claude-sonnet-4-5",
			"execute_tool ls",
			"chat claude-sonnet-4-5",
		]);
		for (const span of spans) {
			expect(span.trace_id).toBe(TRACE_ID);
			// Children of the host's span named by the prompt's traceparent.
			expect(span.parent_span_id).toBe("00f067aa0ba90200");
			expect(span.attributes).toMatchObject({
				"veyra.run_id": "run_test",
				"veyra.fingers.agent_id": "main",
				"veyra.correlation_id": "req_test",
				"gen_ai.conversation.id": expect.any(String),
			});
			for (const name of Object.keys(span.attributes))
				expect(name).not.toMatch(/messages|instructions|arguments|result/);
		}
		expect(spans[0]!.attributes).toMatchObject({
			"gen_ai.operation.name": "chat",
			"gen_ai.provider.name": "anthropic",
			"gen_ai.request.model": "claude-sonnet-4-5",
			"gen_ai.usage.input_tokens": 1000,
			"gen_ai.usage.cache_read.input_tokens": 900,
			"gen_ai.usage.output_tokens": 20,
			"gen_ai.response.finish_reasons": ["tool_call"],
		});
		expect(spans[1]!.attributes).toMatchObject({
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": "ls",
			"gen_ai.tool.call.id": "toolu_ls",
		});
		// A model call's span is the one its request carried in `traceparent`.
		const sent = m.anthropic.requests.map((request) => {
			const value = request.headers.traceparent;
			return Array.isArray(value) ? value.join(",") : value;
		});
		const chats = spans.filter((span) => span.name.startsWith("chat"));
		expect(sent).toEqual(chats.map((span) => `00-${TRACE_ID}-${span.span_id}-01`));
		// Each span follows the usage record of its call; nothing went anywhere but the model endpoint.
		const order = m.outs
			.filter((out) => out.type === "usage" || out.type === "telemetry_span")
			.map((out) => out.type);
		expect(order.slice(0, 2)).toEqual(["usage", "telemetry_span"]);
		const anthropicUrl = `http://127.0.0.1:${(m.anthropic.server.address() as AddressInfo).port}`;
		for (const url of fetched) expect(url.startsWith(anthropicUrl)).toBe(true);
		for (const out of m.outs) expect(validateOutbound(out), JSON.stringify(out)).toEqual([]);
		const logs = m.stderr.map((line) => JSON.parse(line) as Rec);
		expect(logs.find((log) => log.msg === "configured")).toMatchObject({
			telemetry_mode: "relay",
			telemetry_capture_content: false,
		});
	});

	it("adds prompts, answers and tool calls only with capture_content, and never the credential", async () => {
		const m = await startManaged([
			{
				content: [{ type: "toolCall", id: "toolu_ls", name: "ls", arguments: { path: "." } }],
				usage,
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: `The token was ${TOKEN}.` }], usage, stopReason: "stop" },
		]);
		await m.configure({
			tools: { builtin: ["ls"], approval: "never" },
			telemetry: { mode: "relay", capture_content: true },
			system_prompt: "Work in small steps.",
		});
		await m.credentials();
		await m.command({ type: "prompt", message: `Check the token ${TOKEN} for me.` });
		await m.waitFor("result");
		const spans = spansOf(m.outs);
		const [first, tool, last] = spans as [Rec, Rec, Rec];
		expect(JSON.parse(first.attributes["gen_ai.input.messages"])[0]).toEqual({
			role: "user",
			parts: [{ type: "text", content: "Check the token [redacted] for me." }],
		});
		expect(first.attributes["gen_ai.system_instructions"]).toContain("Work in small steps.");
		expect(JSON.parse(first.attributes["gen_ai.output.messages"])[0].parts[0]).toMatchObject({
			type: "tool_call",
			name: "ls",
			arguments: { path: "." },
		});
		expect(tool.attributes["gen_ai.tool.call.arguments"]).toBe('{"path":"."}');
		expect(JSON.parse(last.attributes["gen_ai.output.messages"])[0].parts[0].content).toBe(
			"The token was [redacted].",
		);
		expect(JSON.stringify(m.outs)).not.toContain(TOKEN);
		// The tracer masked the spans itself: the stdout scrubber had nothing to remove from them.
		const logs = m.stderr.map((line) => JSON.parse(line) as Rec);
		const scrubbed = logs.filter((log) => log.msg === "secret value removed from a protocol record");
		expect(scrubbed.map((log) => log.record_type)).not.toContain("telemetry_span");
		for (const out of m.outs) expect(validateOutbound(out), JSON.stringify(out)).toEqual([]);
	});

	it("marks a failed model call with its error type and no provider text", async () => {
		const m = await startManaged([
			{
				content: [],
				usage,
				stopReason: "error",
				error: {
					status: 400,
					body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad things" } }),
				},
			},
		]);
		await m.configure({ telemetry: { mode: "relay" } });
		await m.credentials();
		await m.command({ type: "prompt", message: "hello" });
		await m.waitFor("result");
		const [span] = spansOf(m.outs);
		expect(span).toMatchObject({ status: { code: "error" }, attributes: { "error.type": "provider_error" } });
		expect(JSON.stringify(span)).not.toContain("bad things");
	});
});
