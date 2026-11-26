/**
 * Managed RPC state across processes (F7): checkpoint export and import (resume and fork), the model
 * credential surviving a session replacement, and the budget hard stop holding for later prompts.
 *
 * "A fresh process" is a second ManagedRpcServer with its own agent and session directories that shares only
 * the checkpoint directory with the first, as two Hands runner processes share the checkpoint store.
 */
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateOutbound } from "../src/modes/rpc/managed/contract.ts";
import { ManagedRpcServer } from "../src/modes/rpc/managed/managed-rpc-server.ts";
import { createManagedRuntimeFactory } from "../src/modes/rpc/managed/managed-runtime.ts";
import { listen, type ScriptedResponse, startFakeAnthropic } from "./managed-rpc-fakes.ts";

type Rec = Record<string, any>;

const TOKEN = "hpt_run_ckpt_Zq81vK1xYwT0b";
const TRACE = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba90300-01";
const usage = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 };
const text = (value: string): ScriptedResponse => ({
	content: [{ type: "text", text: value }],
	usage,
	stopReason: "stop",
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllEnvs();
});

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

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

/** A shared root holding the workspace and the checkpoint directory, like one Hands run's sandbox. */
function sandbox() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fingers-ckpt-")));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "workspace");
	const checkpoints = join(root, "run", "veyra", "checkpoints");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(checkpoints, { recursive: true });
	return { root, workspace, checkpoints };
}

let processes = 0;

/** One managed Fingers "process" with its own agent and session directories. */
async function startProcess(box: ReturnType<typeof sandbox>, responses: ScriptedResponse[]) {
	vi.stubEnv("ANTHROPIC_API_KEY", "");
	const own = join(box.root, `proc-${++processes}`);
	const anthropic = startFakeAnthropic(responses);
	const anthropicUrl = await listen(anthropic.server);
	cleanups.push(() => new Promise<void>((resolve) => anthropic.server.close(() => resolve())));
	const outs: Rec[] = [];
	const stderr: string[] = [];
	const server = new ManagedRpcServer({
		io: { writeStdout: (line) => outs.push(JSON.parse(line)), writeStderr: (line) => stderr.push(line) },
		createRuntime: createManagedRuntimeFactory({ agentDir: join(own, "agent"), sessionDir: join(own, "sessions") }),
		version: "0.1.0",
		env: "test",
	});
	cleanups.push(() => server.shutdown("test end"));
	server.start();
	let n = 0;
	const command = async (record: Rec): Promise<Rec> => {
		const id = record.id ?? `c${++n}`;
		await server.handleLine(JSON.stringify({ traceparent: TRACE, ...record, id }));
		await vi.waitFor(() => expect(outs.some((out) => out.type === "response" && out.id === id)).toBe(true), {
			timeout: 10_000,
			interval: 10,
		});
		return outs.find((out) => out.type === "response" && out.id === id)!;
	};
	const waitFor = async (type: string, count = 1) => {
		await vi.waitFor(() => expect(outs.filter((out) => out.type === type).length).toBeGreaterThanOrEqual(count), {
			timeout: 15_000,
			interval: 10,
		});
		return outs.filter((out) => out.type === type);
	};
	const configure = (extra: Rec = {}) =>
		command({
			type: "configure",
			run_id: "run_ckpt",
			request_id: "req_ckpt",
			workspace: { root: box.workspace, protected_paths: [join(box.root, "run", "veyra")] },
			model: { provider: "anthropic", model_id: "claude-sonnet-4-5" },
			checkpoints: { dir: box.checkpoints },
			...extra,
		});
	const credentials = () =>
		command({
			type: "credentials",
			provider: "anthropic",
			base_url: anthropicUrl,
			credential_kind: "proxy_token",
			credential: TOKEN,
			expires_at: new Date(Date.now() + 3_600_000).toISOString(),
		});
	/** Prompt and wait for its result. */
	const run = async (message: string) => {
		const before = outs.filter((out) => out.type === "result").length;
		const response = await command({ type: "prompt", message });
		expect(response, JSON.stringify(response)).toMatchObject({ success: true });
		const results = await waitFor("result", before + 1);
		return results[before]!;
	};
	return { own, server, outs, stderr, command, waitFor, configure, credentials, run, anthropic };
}

function userTexts(request: { body: Rec }): string[] {
	return (request.body.messages as Rec[])
		.filter((message) => message.role === "user")
		.flatMap((message) =>
			typeof message.content === "string"
				? [message.content]
				: (message.content as Rec[]).filter((block) => block.type === "text").map((block) => block.text),
		);
}

describe("managed RPC checkpoints", () => {
	it("announces the checkpoints capability", async () => {
		const box = sandbox();
		const a = await startProcess(box, []);
		expect(a.outs[0]!.capabilities).toContain("checkpoints");
	});

	it("export -> fresh process -> import resume continues with an identical transcript", async () => {
		const box = sandbox();
		const a = await startProcess(box, [text("Plan: 1. schema 2. backfill."), text("Added a step 3.")]);
		await a.configure();
		await a.credentials();
		await a.run("Write the migration plan.");
		await a.run(`Add a third step. (token ${TOKEN} must never be stored)`);
		const messagesA = (await a.command({ type: "get_messages" })).data.messages;

		const path = join(box.checkpoints, "cp_6.jsonl");
		const exported = await a.command({ type: "checkpoint_export", path, label: "plan written" });
		expect(exported).toMatchObject({ success: true, command: "checkpoint_export" });
		const checkpoint = exported.data.checkpoint;
		expect(checkpoint).toMatchObject({
			id: "cp_6",
			format: "fingers.session.v1",
			session_id: a.server.currentSession!.sessionId,
			entry_id: a.server.currentSession!.sessionManager.getLeafId(),
			label: "plan written",
			path,
			sha256: sha256(path),
			size_bytes: statSync(path).size,
			// The system prompt Fingers records at the start, then two user/assistant pairs.
			message_count: 5,
		});
		expect(Date.parse(checkpoint.created_at)).not.toBeNaN();
		const created = (await a.waitFor("checkpoint_created"))[0]!;
		expect(created).toMatchObject({
			checkpoint_id: "cp_6",
			label: "plan written",
			sha256: checkpoint.sha256,
			size_bytes: checkpoint.size_bytes,
			entry_id: checkpoint.entry_id,
		});
		// The checkpoint is a session file with secrets removed, readable only by its owner.
		const content = readFileSync(path, "utf8");
		expect(content).toContain("Add a third step.");
		expect(content).not.toContain(TOKEN);
		expect(statSync(path).mode & 0o077).toBe(0);
		// No temporary file is left next to it.
		expect(readdirSync(box.checkpoints)).toEqual(["cp_6.jsonl"]);

		const b = await startProcess(box, [text("Step 1 done.")]);
		await b.configure();
		await b.credentials();
		const imported = await b.command({
			type: "checkpoint_import",
			path,
			sha256: checkpoint.sha256,
			mode: "resume",
		});
		expect(imported).toMatchObject({
			success: true,
			data: { session_id: checkpoint.session_id, mode: "resume", entry_id: checkpoint.entry_id },
		});
		expect(imported.data.forked_from).toBeUndefined();
		const messagesB = (await b.command({ type: "get_messages" })).data.messages;
		// Identical. (Stdout never shows the secret the person typed; only process A's memory still holds it.)
		expect(messagesB).toEqual(messagesA);
		expect(JSON.stringify(messagesA)).not.toContain(TOKEN);
		expect(JSON.stringify(a.server.currentSession!.messages)).toContain(TOKEN);
		expect((await b.command({ type: "get_state" })).data.sessionId).toBe(checkpoint.session_id);

		// The resumed session goes on: the model sees the whole history, and the credential still works.
		const result = await b.run("Now do step 1 only.");
		expect(result).toMatchObject({ status: "completed", session_id: checkpoint.session_id, text: "Step 1 done." });
		expect(b.anthropic.requests).toHaveLength(1);
		expect(b.anthropic.requests[0]!.headers["x-api-key"]).toBe(TOKEN);
		expect(userTexts(b.anthropic.requests[0]!)).toEqual([
			"Write the migration plan.",
			"Add a third step. (token [redacted] must never be stored)",
			"Now do step 1 only.",
		]);
		for (const out of [...a.outs, ...b.outs]) expect(validateOutbound(out), JSON.stringify(out)).toEqual([]);
		for (const file of [...filesUnder(a.own), ...filesUnder(b.own), path]) {
			expect(readFileSync(file, "utf8"), file).not.toContain(TOKEN);
		}
		expect(a.stderr.join("") + b.stderr.join("")).not.toContain(TOKEN);
	});

	it("a resumed session takes the system_prompt of the importing process's configure (F6c)", async () => {
		const systemText = (request: { body: Rec }): string =>
			typeof request.body.system === "string"
				? request.body.system
				: ((request.body.system ?? []) as Rec[]).map((block) => block.text).join("\n");
		const box = sandbox();
		const a = await startProcess(box, [text("Plan written.")]);
		await a.configure({ system_prompt: "Instructions v1: write plans as numbered lists." });
		await a.credentials();
		await a.run("Write the plan.");
		expect(systemText(a.anthropic.requests[0]!)).toContain("Instructions v1");
		const path = join(box.checkpoints, "cp_sp.jsonl");
		const checkpoint = (await a.command({ type: "checkpoint_export", path })).data.checkpoint;

		const b = await startProcess(box, [text("Step 1 done.")]);
		await b.configure({ system_prompt: "Instructions v2: answer in one line." });
		await b.credentials();
		const imported = await b.command({ type: "checkpoint_import", path, sha256: checkpoint.sha256, mode: "resume" });
		expect(imported).toMatchObject({ success: true });
		await b.run("Do step 1.");
		const system = systemText(b.anthropic.requests[0]!);
		expect(system).toContain("Instructions v2: answer in one line.");
		expect(system).not.toContain("Instructions v1");
		expect(system).toContain("running inside fingers");
		expect(JSON.stringify(b.anthropic.requests[0]!.body.messages)).not.toContain("Instructions v");
	});

	it("import fork starts a new session at the given entry", async () => {
		const box = sandbox();
		const a = await startProcess(box, [text("First answer."), text("Second answer.")]);
		await a.configure();
		await a.credentials();
		await a.run("first question");
		await a.run("second question");
		const path = join(box.checkpoints, "two-turns.jsonl");
		const checkpoint = (await a.command({ type: "checkpoint_export", path })).data.checkpoint;
		expect(checkpoint.id).toMatch(/^cp_[A-Za-z0-9]+$/);
		// Fork right after the first answer.
		const entries = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Rec);
		const firstAnswer = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant")!
			.id as string;

		const b = await startProcess(box, [text("Forked answer.")]);
		await b.configure();
		await b.credentials();
		const forked = await b.command({
			type: "checkpoint_import",
			path,
			sha256: checkpoint.sha256,
			mode: "fork",
			entry_id: firstAnswer,
		});
		expect(forked).toMatchObject({
			success: true,
			data: { mode: "fork", entry_id: firstAnswer, forked_from: checkpoint.session_id },
		});
		expect(forked.data.session_id).not.toBe(checkpoint.session_id);
		expect(b.server.currentSession!.sessionId).toBe(forked.data.session_id);
		const messages = (await b.command({ type: "get_messages" })).data.messages as Rec[];
		expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);

		const result = await b.run("third question");
		expect(result).toMatchObject({ status: "completed", session_id: forked.data.session_id });
		expect(userTexts(b.anthropic.requests[0]!)).toEqual(["first question", "third question"]);

		// Without entry_id the fork starts at the checkpoint's leaf; the source session is untouched.
		const c = await startProcess(box, []);
		await c.configure();
		const atLeaf = await c.command({ type: "checkpoint_import", path, sha256: checkpoint.sha256, mode: "fork" });
		expect(atLeaf).toMatchObject({ success: true, data: { entry_id: checkpoint.entry_id } });
		expect(((await c.command({ type: "get_messages" })).data.messages as Rec[]).length).toBe(5);
		expect(sha256(path)).toBe(checkpoint.sha256);
		for (const out of [...a.outs, ...b.outs, ...c.outs])
			expect(validateOutbound(out), JSON.stringify(out)).toEqual([]);
	});

	it("refuses a wrong checksum, paths outside checkpoints.dir, a missing file and unknown entries", async () => {
		const box = sandbox();
		const a = await startProcess(box, [text("ok")]);
		await a.configure();
		await a.credentials();
		await a.run("hello");
		const path = join(box.checkpoints, "cp_1.jsonl");
		const { checkpoint } = (await a.command({ type: "checkpoint_export", path })).data;

		const b = await startProcess(box, []);
		await b.configure();
		const sessionBefore = b.server.currentSession!.sessionId;
		const bad = "0".repeat(64);
		expect(await b.command({ type: "checkpoint_import", path, sha256: bad, mode: "resume" })).toMatchObject({
			success: false,
			code: "checksum_mismatch",
		});
		expect(
			await b.command({
				type: "checkpoint_import",
				path: join(box.workspace, "x.jsonl"),
				sha256: bad,
				mode: "resume",
			}),
		).toMatchObject({ success: false, code: "path_not_allowed" });
		expect(
			await b.command({
				type: "checkpoint_import",
				path: join(box.checkpoints, "..", "escape.jsonl"),
				sha256: bad,
				mode: "resume",
			}),
		).toMatchObject({ success: false, code: "path_not_allowed" });
		expect(
			await b.command({
				type: "checkpoint_import",
				path: join(box.checkpoints, "missing.jsonl"),
				sha256: bad,
				mode: "resume",
			}),
		).toMatchObject({ success: false, code: "not_found" });
		expect(
			await b.command({
				type: "checkpoint_import",
				path,
				sha256: checkpoint.sha256,
				mode: "fork",
				entry_id: "no-such-entry",
			}),
		).toMatchObject({ success: false, code: "not_found" });
		expect(
			await b.command({ type: "checkpoint_import", path, sha256: checkpoint.sha256, mode: "resume", entry_id: "x" }),
		).toMatchObject({ success: false, code: "invalid_command" });
		// A file that is not a session.
		const junk = join(box.checkpoints, "junk.jsonl");
		writeFileSync(junk, "not a session\n");
		expect(
			await b.command({ type: "checkpoint_import", path: junk, sha256: sha256(junk), mode: "resume" }),
		).toMatchObject({ success: false, code: "invalid_command" });
		// None of the refusals replaced the session.
		expect(b.server.currentSession!.sessionId).toBe(sessionBefore);

		// Export: outside the directory, through a symlink that leaves it, and with no checkpoints.dir.
		expect(await a.command({ type: "checkpoint_export", path: join(box.workspace, "cp.jsonl") })).toMatchObject({
			success: false,
			code: "path_not_allowed",
		});
		symlinkSync(box.workspace, join(box.checkpoints, "link"));
		expect(
			await a.command({ type: "checkpoint_export", path: join(box.checkpoints, "link", "cp.jsonl") }),
		).toMatchObject({ success: false, code: "path_not_allowed" });
		expect(readdirSync(box.workspace)).toEqual([]);
		const c = await startProcess(box, []);
		await c.configure({ checkpoints: undefined });
		expect(await c.command({ type: "checkpoint_export", path })).toMatchObject({
			success: false,
			code: "path_not_allowed",
		});
		for (const out of [...a.outs, ...b.outs, ...c.outs])
			expect(validateOutbound(out), JSON.stringify(out)).toEqual([]);
	});
});

describe("managed RPC session replacement", () => {
	it("keeps the model credential after clone and fork", async () => {
		const box = sandbox();
		const a = await startProcess(box, [text("one"), text("two"), text("three")]);
		await a.configure();
		await a.credentials();
		await a.run("first");
		expect(await a.command({ type: "clone" })).toMatchObject({ success: true });
		expect(await a.run("second")).toMatchObject({ status: "completed", text: "two" });
		const firstUser = a.server
			.currentSession!.sessionManager.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user")!.id;
		expect(await a.command({ type: "fork", entryId: firstUser })).toMatchObject({ success: true });
		expect(await a.run("third")).toMatchObject({ status: "completed", text: "three" });
		expect(a.anthropic.requests).toHaveLength(3);
		for (const request of a.anthropic.requests) expect(request.headers["x-api-key"]).toBe(TOKEN);
	});
});

describe("managed RPC budget hard stop", () => {
	it("a prompt after max_cost_usd was reached makes no model call and stops again", async () => {
		const box = sandbox();
		const a = await startProcess(box, [text("expensive"), text("must not be asked")]);
		// claude-sonnet-4-5 list price: 1000 input + 100 output tokens = $0.0045.
		await a.configure({ limits: { max_cost_usd: 0.001 } });
		await a.credentials();
		expect(await a.run("first")).toMatchObject({ status: "stopped", stop_reason: "max_cost_reached" });
		const second = await a.run("second");
		expect(second).toMatchObject({
			status: "stopped",
			stop_reason: "max_cost_reached",
			failure: { code: "max_cost_reached" },
			turns: 0,
		});
		expect(a.anthropic.requests).toHaveLength(1);
		expect(a.outs.filter((out) => out.type === "agent_settled").map((out) => out.aborted)).toEqual([true, true]);
		expect(a.outs.filter((out) => out.type === "notice").map((out) => out.code)).toEqual([
			"limit_reached",
			"limit_reached",
		]);
		for (const out of a.outs) expect(validateOutbound(out), JSON.stringify(out)).toEqual([]);
	});
});
