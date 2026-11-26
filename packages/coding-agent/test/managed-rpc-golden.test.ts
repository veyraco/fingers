/**
 * Replays the Fingers RPC v1 golden transcripts (veyraco/platform contracts/v1/testdata/fingers-rpc, synced
 * into test/fixtures/fingers-rpc) against the real managed mode: the real runtime factory, the real Anthropic
 * provider pointed at a local fake Anthropic server through the `credentials` message, a local fake MCP server,
 * real tools in a temporary workspace. The host side sends each `in` record once the `out` record before it
 * in the transcript has been seen, and the output is compared with the transcript.
 */
import { createHash } from "node:crypto";
import {
	chmodSync,
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
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateOutbound } from "../src/modes/rpc/managed/contract.ts";
import { ManagedRpcServer } from "../src/modes/rpc/managed/managed-rpc-server.ts";
import { createManagedRuntimeFactory } from "../src/modes/rpc/managed/managed-runtime.ts";
import { listen, type ScriptedResponse, startFakeAnthropic, startFakeMcp, toolName } from "./managed-rpc-fakes.ts";

type Rec = Record<string, any>;
type Line = { dir: "in" | "out"; record: Rec };

const FIXTURES = join(__dirname, "fixtures", "fingers-rpc");

function loadGolden(name: string): Line[] {
	return readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Line);
}

function scriptedResponses(golden: Line[]): ScriptedResponse[] {
	return golden
		.filter(
			(line) => line.dir === "out" && line.record.type === "message_end" && line.record.message.role === "assistant",
		)
		.map((line) => line.record.message)
		.filter((message) => message.stopReason !== "error")
		.map((message) => ({ content: message.content, usage: message.usage, stopReason: message.stopReason }));
}

// ---------------------------------------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------------------------------------

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllEnvs();
});

interface Replay {
	outs: Rec[];
	stderr: string[];
	root: string;
	anthropic: ReturnType<typeof startFakeAnthropic>;
	mcp: ReturnType<typeof startFakeMcp>;
	secrets: string[];
	credential: () => string | undefined;
	expiresAt: () => string | undefined;
}

async function replay(
	name: string,
	prepareWorkspace: (workspace: string) => void,
): Promise<{ golden: Line[]; run: Replay }> {
	const golden = loadGolden(name);
	const root = realpathSync(mkdtempSync(join(tmpdir(), `fingers-golden-${name}-`)));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "workspace");
	const runDir = join(root, "run", "veyra");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(join(runDir, "checkpoints"), { recursive: true });
	prepareWorkspace(workspace);
	// A `pnpm` stub for the approval transcript's test command.
	const bin = join(root, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "pnpm"), "#!/bin/sh\necho 'Tests: 12 passed'\n");
	chmodSync(join(bin, "pnpm"), 0o755);
	vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
	vi.stubEnv("ANTHROPIC_API_KEY", "");

	const anthropic = startFakeAnthropic(scriptedResponses(golden));
	const anthropicUrl = await listen(anthropic.server);
	cleanups.push(() => new Promise<void>((resolve) => anthropic.server.close(() => resolve())));
	const mcp = startFakeMcp();
	const mcpUrl = await listen(mcp.server);
	cleanups.push(() => new Promise<void>((resolve) => mcp.server.close(() => resolve())));

	const secrets: string[] = [];
	let credential: string | undefined;
	let expiresAt: string | undefined;
	const rewrite = (record: Rec): Rec => {
		const copy = structuredClone(record);
		if (copy.type === "configure") {
			copy.workspace = { root: workspace, protected_paths: [join(root, "run", "veyra")] };
			copy.checkpoints = { dir: join(runDir, "checkpoints") };
			for (const server of copy.mcp_servers ?? []) {
				server.url = `${mcpUrl}/mcp`;
				secrets.push(...Object.values(server.headers ?? {}).map(String));
			}
		}
		if (copy.type === "checkpoint_export" || copy.type === "checkpoint_import") {
			copy.path = copy.path.replace(/^\/run\/veyra(?=\/)/, runDir);
		}
		if (copy.type === "checkpoint_import") {
			// The transcript's hash is illustrative: import the file the export really wrote.
			const exported = outs.find((out) => out.type === "response" && out.command === "checkpoint_export");
			copy.sha256 = exported?.data?.checkpoint?.sha256 ?? copy.sha256;
		}
		if (copy.type === "credentials") {
			copy.base_url = anthropicUrl;
			credential = copy.credential;
			// The transcripts' expiry is a fixed past date; keep the credential valid for the replay.
			copy.expires_at = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
			expiresAt = copy.expires_at;
			secrets.push(copy.credential, ...Object.values(copy.headers ?? {}).map(String));
		}
		return copy;
	};

	const outs: Rec[] = [];
	const stderr: string[] = [];
	const seen = new Map<string, number>();
	const approvalIds: string[] = [];
	// Each in record waits for the out record before it: [type key, occurrence].
	const steps: Array<{ record: Rec; after: [string, number] }> = [];
	const goldenSeen = new Map<string, number>();
	let lastOut: [string, number] = ["", 0];
	const keyOf = (record: Rec): string => (record.type === "response" ? `response:${record.id}` : record.type);
	for (const line of golden) {
		if (line.dir === "out") {
			if (line.record.type === "message_update") continue;
			const key = keyOf(line.record);
			goldenSeen.set(key, (goldenSeen.get(key) ?? 0) + 1);
			lastOut = [key, goldenSeen.get(key)!];
		} else {
			steps.push({ record: line.record, after: lastOut });
		}
	}
	const goldenApprovalIds = golden
		.filter((line) => line.dir === "out" && line.record.type === "approval_request")
		.map((line) => line.record.id as string);

	let server: ManagedRpcServer;
	let next = 0;
	const pump = () => {
		while (next < steps.length) {
			const step = steps[next]!;
			const [key, count] = step.after;
			if ((seen.get(key) ?? 0) < count) return;
			next++;
			let record = rewrite(step.record);
			if (record.type === "approval_response") {
				record = { ...record, id: approvalIds[goldenApprovalIds.indexOf(record.id)] };
			}
			void server.handleLine(JSON.stringify(record));
		}
	};

	server = new ManagedRpcServer({
		io: {
			writeStdout: (line) => {
				expect(line.endsWith("\n")).toBe(true);
				const record = JSON.parse(line) as Rec;
				outs.push(record);
				if (record.type === "approval_request") approvalIds.push(record.id);
				const key = keyOf(record);
				seen.set(key, (seen.get(key) ?? 0) + 1);
				pump();
			},
			writeStderr: (line) => stderr.push(line),
		},
		createRuntime: createManagedRuntimeFactory({
			agentDir: join(root, "agent"),
			sessionDir: join(root, "sessions"),
		}),
		version: "0.1.0",
		env: "test",
	});
	cleanups.push(() => server.shutdown("test end"));
	server.start();
	pump();

	const results = golden.filter((line) => line.dir === "out" && line.record.type === "result").length;
	if (process.env.DEBUG_GOLDEN) {
		cleanups.push(() => {
			for (const record of outs) console.log("OUT", JSON.stringify(record).slice(0, 400));
			for (const line of stderr) console.log("ERR", line.slice(0, 400));
		});
	}
	await vi.waitFor(
		() => {
			expect(outs.filter((record) => record.type === "result").length).toBe(results);
		},
		{ timeout: 20_000, interval: 20 },
	);
	// Responses to commands sent after the last result (get_session_stats) may still be in flight.
	await vi.waitFor(() => expect(next).toBe(steps.length), { timeout: 5_000, interval: 20 });
	await new Promise((resolve) => setTimeout(resolve, 50));
	return {
		golden,
		run: { outs, stderr, root, anthropic, mcp, secrets, credential: () => credential, expiresAt: () => expiresAt },
	};
}

/**
 * Pi streams more message_update and tool_execution_update deltas than the hand-written transcripts show, and
 * announces the system
 * prompt as a `system` message at the start of every run and each tool result as a `toolResult` message, which
 * the transcripts leave out: compare without them.
 */
function isSystemMessageEvent(record: Rec): boolean {
	return (
		(record.type === "message_start" || record.type === "message_end") &&
		(record.message?.role === "system" || record.message?.role === "toolResult")
	);
}

function eventTypes(records: Rec[], ignore: readonly string[] = []): string[] {
	return records
		.filter(
			(record) =>
				!ignore.includes(record.type) &&
				record.type !== "response" &&
				record.type !== "message_update" &&
				record.type !== "tool_execution_update" &&
				!isSystemMessageEvent(record),
		)
		.map((record) => record.type);
}

function filesUnder(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) files.push(...filesUnder(path));
		else files.push(path);
	}
	return files;
}

function expectCloseTotals(actual: Rec, expected: Rec): void {
	expect(actual.tokens).toEqual(expected.tokens);
	for (const key of Object.keys(expected.cost_usd))
		expect(actual.cost_usd[key], key).toBeCloseTo(expected.cost_usd[key], 9);
}

/** `notYet`: event types of the transcript this build does not emit yet (each names the item that adds it). */
function checkCommon(golden: Line[], run: Replay, notYet: readonly string[] = []): void {
	const goldenOuts = golden.filter((line) => line.dir === "out").map((line) => line.record);
	// Same events in the same order.
	expect(eventTypes(run.outs)).toEqual(eventTypes(goldenOuts, notYet));
	// Every record conforms to the contract's schemas; seq strictly increases from 1.
	let seq = 0;
	for (const record of run.outs) {
		expect(validateOutbound(record), JSON.stringify(record).slice(0, 300)).toEqual([]);
		if (record.type === "response") continue;
		expect(record.seq).toBe(seq + 1);
		seq = record.seq;
	}
	// One response per command, matching the transcript.
	for (const expected of goldenOuts.filter((record) => record.type === "response")) {
		const actual = run.outs.filter((record) => record.type === "response" && record.id === expected.id);
		expect(actual, expected.id).toHaveLength(1);
		expect(actual[0]).toMatchObject({ command: expected.command, success: expected.success });
		if (expected.command === "credentials") {
			expect(actual[0]!.data).toEqual({ ...expected.data, expires_at: run.expiresAt() });
		}
		if (expected.command === "configure") expect(actual[0]!.data.session_id).toEqual(expect.any(String));
		if (expected.command === "prompt" || expected.command === "steer") expect(actual[0]!.data).toEqual(expected.data);
	}
	const hello = run.outs[0]!;
	expect(hello).toMatchObject({
		type: "hello",
		seq: 1,
		protocol: "veyra.fingers.rpc.v1",
		managed: true,
		fingers_version: "0.1.0",
	});
	for (const capability of hello.capabilities) expect(goldenOuts[0]!.capabilities).toContain(capability);

	const pick = (records: Rec[], type: string) => records.filter((record) => record.type === type);
	// Usage: per call and cumulative, from the model's list prices.
	const usages = pick(run.outs, "usage");
	const goldenUsages = pick(goldenOuts, "usage");
	expect(usages).toHaveLength(goldenUsages.length);
	usages.forEach((usage, index) => {
		const expected = goldenUsages[index]!;
		expect(usage).toMatchObject({
			provider: expected.provider,
			model: expected.model,
			cost_source: expected.cost_source,
		});
		expectCloseTotals(usage.turn, expected.turn);
		expectCloseTotals(usage.cumulative, expected.cumulative);
	});
	// Tool executions and their outcome; a denied call carries the host's reason.
	const ends = pick(run.outs, "tool_execution_end");
	pick(goldenOuts, "tool_execution_end").forEach((expected, index) => {
		expect(ends[index]).toMatchObject({
			toolCallId: expected.toolCallId,
			toolName: toolName(expected.toolName),
			isError: expected.isError,
		});
		if (expected.isError) expect(ends[index]!.result.content[0].text).toBe(expected.result.content[0].text);
	});
	expect(pick(run.outs, "file_changed").map(({ seq: _seq, ...rest }) => rest)).toEqual(
		pick(goldenOuts, "file_changed").map(({ seq: _seq, ...rest }) => rest),
	);
	expect(pick(run.outs, "notice").map((record) => [record.level, record.code])).toEqual(
		pick(goldenOuts, "notice").map((record) => [record.level, record.code]),
	);
	expect(pick(run.outs, "agent_settled").map((record) => record.aborted)).toEqual(
		pick(goldenOuts, "agent_settled").map((record) => record.aborted),
	);
	const results = pick(run.outs, "result");
	pick(goldenOuts, "result").forEach((expected, index) => {
		const actual = results[index]!;
		expect(actual).toMatchObject({
			agent_id: "main",
			status: expected.status,
			stop_reason: expected.stop_reason,
			text: expected.text,
			turns: expected.turns,
		});
		expect(actual.failure?.code ?? null).toBe(expected.failure?.code ?? null);
		expectCloseTotals(actual.usage, expected.usage);
	});

	// The credential went to the model endpoint as its key, and no secret appears anywhere else.
	for (const request of run.anthropic.requests) expect(request.headers["x-api-key"]).toBe(run.credential());
	const stdout = run.outs.map((record) => JSON.stringify(record)).join("\n");
	const stderr = run.stderr.join("");
	const sessionFiles = filesUnder(join(run.root, "sessions"))
		.concat(filesUnder(join(run.root, "agent")))
		.map((file) => readFileSync(file, "utf8"))
		.join("\n");
	for (const secret of run.secrets) {
		expect(stdout).not.toContain(secret);
		expect(stderr).not.toContain(secret);
		expect(sessionFiles).not.toContain(secret);
	}
	// Logs are platform log records with the run's ids.
	const logs = run.stderr.map((line) => JSON.parse(line) as Rec);
	expect(logs.length).toBeGreaterThan(0);
	for (const log of logs)
		expect(log).toMatchObject({ service: "fingers", version: "0.1.0", env: "test", level: expect.any(String) });
	expect(logs.find((log) => log.msg === "configured")).toMatchObject({
		run_id: "run_01JDK2M8Q",
		request_id: "req_01JDK2M8Q",
		trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
	});
}

describe("managed RPC golden transcripts", () => {
	it("managed-run: prompt, read, edit, mid-turn steer, stats", async () => {
		const { golden, run } = await replay("managed-run", (workspace) => {
			mkdirSync(join(workspace, "src/server/routes"), { recursive: true });
			writeFileSync(join(workspace, "src/server/routes/auth.ts"), "export const auth = Router();\n");
		});
		checkCommon(golden, run);
		expect(readFileSync(join(run.root, "workspace/src/server/routes/auth.ts"), "utf8")).toBe(
			"export const auth = Router().use(rateLimit());\n",
		);
		// The steer reached the model before its next call.
		const secondRequest = JSON.stringify(run.anthropic.requests[1]!.body.messages);
		expect(secondRequest).toContain("Reuse the existing rate-limit middleware.");
	});

	it("approval: allow always for a command, deny an MCP write with a reason", async () => {
		const { golden, run } = await replay("approval", () => {});
		checkCommon(golden, run);
		// The denied MCP call never reached the server; the server got the configured header.
		expect(run.mcp.calls).toEqual([]);
		expect(run.mcp.authorizations).toContain("Bearer ghs_mcpHeaderSecret_5f2a");
		// Only allow-listed MCP tools were offered to the model.
		const tools = (run.anthropic.requests[1]!.body.tools as Rec[]).map((tool) => tool.name);
		expect(tools).toContain("mcp__github__create_pull_request");
		expect(tools).not.toContain("mcp__github__delete_repo");
	});

	it("limit-max-cost: the cost cap stops the run after the turn", async () => {
		const { golden, run } = await replay("limit-max-cost", (workspace) => {
			mkdirSync(join(workspace, "src/billing"), { recursive: true });
			writeFileSync(join(workspace, "src/billing/index.ts"), "export {};\n");
		});
		checkCommon(golden, run);
		expect(run.anthropic.requests).toHaveLength(1);
	});

	it("memory-telemetry-relay: memory through the host, one answer and one failure", async () => {
		const fetched: string[] = [];
		const realFetch = globalThis.fetch;
		vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			fetched.push(String(input instanceof Request ? input.url : input));
			return realFetch(input, init);
		});
		cleanups.push(() => vi.unstubAllGlobals());
		const { golden, run } = await replay("memory-telemetry-relay", () => {});
		// telemetry_span comes with the telemetry relay (Fingers F21).
		checkCommon(golden, run, ["telemetry_span"]);
		const requests = run.outs.filter((record) => record.type === "memory_request");
		const goldenRequests = golden
			.filter((line) => line.dir === "out" && line.record.type === "memory_request")
			.map((line) => line.record);
		expect(requests.map((record) => [record.id, record.op])).toEqual(goldenRequests.map((r) => [r.id, r.op]));
		// Context at task start: the task and the configured budget, no space or organization.
		expect(requests[0]!.body).toMatchObject(goldenRequests[0]!.body);
		expect(requests[0]!.body.run_ref).toEqual({ app: "hands", type: "run", id: "run_01JDK2M8Q" });
		expect(requests[0]!.timeout_ms).toBe(3000);
		// The run's outcome, idempotent by an id tied to the run and its last entry.
		const [event] = requests[1]!.body.events;
		expect(event).toMatchObject({ kind: "outcome", ref: { app: "hands", type: "run", id: "run_01JDK2M8Q" } });
		expect(event.id).toMatch(/^run_01JDK2M8Q:[^:]+:outcome$/);
		expect(event.outcome).toEqual({ status: "succeeded" });
		expect(event.text).toBe("Task: Fix the flaky checkout test.\n\nResult: Set STRIPE_FAKE=1 in the test setup.");
		for (const request of requests) {
			for (const key of ["space_id", "space_ids", "brain_space_id", "org_id", "organization_id"])
				expect(request.body).not.toHaveProperty(key);
		}
		// The host's context reached the model in the system prompt, framed as notes.
		const system = JSON.stringify(run.anthropic.requests[0]!.body.system);
		expect(system).toContain("<memory>");
		expect(system).toContain("checkout tests need STRIPE_FAKE=1");
		// The memory tools were offered.
		const tools = (run.anthropic.requests[0]!.body.tools as Rec[]).map((tool) => tool.name);
		expect(tools).toEqual(expect.arrayContaining(["memory_recall", "memory_remember"]));
		// Relay mode: Fingers called no memory service; its only HTTP went to the model endpoint.
		const anthropicUrl = `http://127.0.0.1:${(run.anthropic.server.address() as AddressInfo).port}`;
		expect(fetched.length).toBeGreaterThan(0);
		for (const url of fetched) expect(url.startsWith(anthropicUrl)).toBe(true);
		const logs = run.stderr.map((line) => JSON.parse(line) as Rec);
		expect(logs.find((log) => log.msg === "configured")).toMatchObject({ memory_mode: "relay" });
		expect(logs.filter((log) => log.msg === "memory request").map((log) => log.op)).toEqual(["context", "events"]);
	});

	it("checkpoint-fork: export after a run, fork from the checkpoint, continue in the fork", async () => {
		const { golden, run } = await replay("checkpoint-fork", () => {});
		checkCommon(golden, run);
		const responses = (command: string) =>
			run.outs.find((record) => record.type === "response" && record.command === command)!;
		const configured = responses("configure").data.session_id as string;
		const expected = golden.find((line) => line.dir === "out" && line.record.id === "cmd-4")!.record.data.checkpoint;
		const checkpoint = responses("checkpoint_export").data.checkpoint;
		expect(checkpoint).toMatchObject({
			id: expected.id,
			format: expected.format,
			label: expected.label,
			session_id: configured,
			path: join(run.root, "run/veyra/checkpoints/cp_6.jsonl"),
			message_count: expected.message_count,
		});
		const file = readFileSync(checkpoint.path);
		expect(checkpoint.size_bytes).toBe(file.length);
		expect(checkpoint.sha256).toBe(createHash("sha256").update(file).digest("hex"));
		expect(run.outs.find((record) => record.type === "checkpoint_created")).toMatchObject({
			checkpoint_id: expected.id,
			sha256: checkpoint.sha256,
			entry_id: checkpoint.entry_id,
		});
		const imported = responses("checkpoint_import").data;
		expect(imported).toMatchObject({ mode: "fork", entry_id: checkpoint.entry_id, forked_from: configured });
		expect(imported.session_id).not.toBe(configured);
		const results = run.outs.filter((record) => record.type === "result");
		expect(results.map((record) => record.session_id)).toEqual([configured, imported.session_id]);
		// The fork carries the first exchange to the model.
		expect(JSON.stringify(run.anthropic.requests[1]!.body.messages)).toContain(
			"Plan: 1. schema 2. backfill 3. switch.",
		);
	});
});
