// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * Sub-agents in managed RPC mode with the real ee engine: the managed server activates this module with only
 * `subagents` on, the host turns them on with `configure.subagents`, and children run as real sessions in real git
 * worktrees under the managed gate; their changes merge into the workspace; a sub-agent checkpoint over RPC keeps its
 * worktree and transcript and rolls both back; a repository whose root lies outside the workspace gets no worktree.
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateOutbound } from "../../packages/coding-agent/src/modes/rpc/managed/contract.ts";
import { ManagedRpcServer } from "../../packages/coding-agent/src/modes/rpc/managed/managed-rpc-server.ts";
import { createManagedRuntimeFactory } from "../../packages/coding-agent/src/modes/rpc/managed/managed-runtime.ts";
import {
	managedSubagentEngine,
	REPOSITORY_OUTSIDE_WORKSPACE,
} from "../../packages/coding-agent/src/modes/rpc/managed/subagents.ts";
import {
	listen,
	type ScriptedResponse,
	startFakeAnthropic,
} from "../../packages/coding-agent/test/managed-rpc-fakes.ts";
import eeModule from "../src/index.ts";

type Rec = Record<string, any>;

const TOKEN = "hpt_run_ee_sub4gents_Zr3vK1xY";
const TRACE = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba90200-01";
const USAGE = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 };
const SUB_AGENT_RULES = /You are sub-agent (sub_\d+)/;
const DOC_PATH = /docs\/[ab]\.md/;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllEnvs();
});

function git(cwd: string, ...args: string[]): string {
	const env = { ...process.env };
	for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
	const result = spawnSync(
		"git",
		["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
		{ cwd, encoding: "utf8", env },
	);
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

function text(value: string): ScriptedResponse {
	return { content: [{ type: "text", text: value }], usage: USAGE, stopReason: "stop" };
}

function tool(id: string, name: string, args: Rec): ScriptedResponse {
	return { content: [{ type: "toolCall", id, name, arguments: args }], usage: USAGE, stopReason: "toolUse" };
}

function agentOf(body: Rec): string {
	return JSON.stringify(body.system ?? "").match(SUB_AGENT_RULES)?.[1] ?? "main";
}

function turnOf(body: Rec): number {
	return (body.messages as Rec[]).filter((message) => message.role === "assistant").length;
}

/** The text of the first user message: a child's task. */
function taskOf(body: Rec): string {
	const first = (body.messages as Rec[]).find((message) => message.role === "user");
	const content = first?.content;
	return typeof content === "string" ? content : ((content as Rec[]) ?? []).map((block) => block.text ?? "").join("");
}

function gate(): { promise: Promise<void>; open: () => void } {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

/** A git repository (`repoRoot`) whose `workspace` is the root itself or a folder in it. */
function repository(workspaceSub?: string): { repoRoot: string; workspace: string; root: string } {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "fingers-ee-managed-")));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const repoRoot = join(root, "repo");
	mkdirSync(repoRoot);
	git(repoRoot, "init", "-q", "-b", "main");
	writeFileSync(join(repoRoot, "README.md"), "# app\n");
	git(repoRoot, "add", "-A");
	git(repoRoot, "commit", "-qm", "init");
	const workspace = workspaceSub ? join(repoRoot, workspaceSub) : repoRoot;
	mkdirSync(workspace, { recursive: true });
	mkdirSync(join(root, "private"));
	mkdirSync(join(root, "checkpoints"));
	return { repoRoot, workspace, root };
}

async function startManaged(
	place: { workspace: string; root: string },
	respond: (agent: string, turn: number, body: Rec) => ScriptedResponse | Promise<ScriptedResponse>,
) {
	vi.stubEnv("ANTHROPIC_API_KEY", "");
	const anthropic = startFakeAnthropic((body) => respond(agentOf(body), turnOf(body), body));
	const url = await listen(anthropic.server);
	cleanups.push(() => new Promise<void>((resolve) => anthropic.server.close(() => resolve())));
	cleanups.push(() => anthropic.server.closeAllConnections());
	const outs: Rec[] = [];
	const stderr: string[] = [];
	const server = new ManagedRpcServer({
		io: { writeStdout: (line) => outs.push(JSON.parse(line)), writeStderr: (line) => stderr.push(line) },
		createRuntime: createManagedRuntimeFactory({
			agentDir: join(place.root, "agent"),
			sessionDir: join(place.root, "sessions"),
		}),
		version: "0.1.0",
		env: "test",
		subagentEngine: (checkpointsOn) => managedSubagentEngine(eeModule, checkpointsOn),
	});
	cleanups.push(() => server.shutdown("test end"));
	if (process.env.DEBUG_SUBAGENTS) {
		cleanups.push(() => {
			for (const record of outs) console.log("OUT", JSON.stringify(record).slice(0, 300));
			for (const line of stderr) console.log("ERR", line.slice(0, 300));
		});
	}
	server.start();
	let n = 0;
	const send = (record: Rec) => server.handleLine(JSON.stringify({ traceparent: TRACE, ...record }));
	const command = async (record: Rec): Promise<Rec> => {
		const id = `c${++n}`;
		await send({ ...record, id });
		await vi.waitFor(() => expect(outs.some((out) => out.type === "response" && out.id === id)).toBe(true), {
			timeout: 20_000,
			interval: 10,
		});
		return outs.find((out) => out.type === "response" && out.id === id)!;
	};
	const waitFor = async (predicate: (out: Rec) => boolean) => {
		await vi.waitFor(() => expect(outs.some(predicate)).toBe(true), { timeout: 20_000, interval: 10 });
		return outs.filter(predicate);
	};
	expect(
		await command({
			type: "configure",
			run_id: "run_ee",
			request_id: "req_ee",
			workspace: { root: place.workspace, protected_paths: [join(place.root, "private")] },
			model: { provider: "anthropic", model_id: "claude-sonnet-4-5" },
			tools: { builtin: ["read", "write", "edit", "ls"], approval: "never" },
			checkpoints: { dir: join(place.root, "checkpoints") },
			subagents: { enabled: true },
		}),
	).toMatchObject({ success: true });
	expect(
		await command({
			type: "credentials",
			provider: "anthropic",
			base_url: url,
			credential_kind: "proxy_token",
			credential: TOKEN,
			expires_at: new Date(Date.now() + 3_600_000).toISOString(),
		}),
	).toMatchObject({ success: true });
	return { outs, stderr, command, waitFor, anthropic };
}

describe("managed RPC sub-agents with the ee engine", () => {
	it("announces subagents, runs two children in worktrees and merges their files into the workspace", async () => {
		const place = repository();
		const m = await startManaged(place, (agent, turn, body) => {
			if (agent === "main") {
				return turn === 0
					? tool("toolu_agents", "agents", {
							start: [
								{ label: "docs-a", task: "Write docs/a.md" },
								{ label: "docs-b", task: "Write docs/b.md" },
							],
						})
					: text("Both docs are written.");
			}
			const file = taskOf(body).match(DOC_PATH)![0];
			return turn === 0
				? tool(`toolu_${agent}`, "write", { path: file, content: `${file} by ${agent}\n` })
				: text(`${file} written.`);
		});
		expect(m.outs[0]!.capabilities).toContain("subagents");
		await m.command({ type: "prompt", message: "Write the two docs with sub-agents" });
		const [result] = await m.waitFor((out) => out.type === "result");
		expect(result).toMatchObject({ status: "completed" });
		for (const out of m.outs) expect(validateOutbound(out), JSON.stringify(out).slice(0, 300)).toEqual([]);

		const started = m.outs.filter((out) => out.type === "subagent_started");
		expect(started.map((out) => out.label)).toEqual(["docs-a", "docs-b"]);
		for (const out of started) expect(out.worktree).toBe(`.fingers/worktrees/${out.agent_id}`);
		const finished = m.outs.filter((out) => out.type === "subagent_finished");
		expect(finished.map((out) => out.status)).toEqual(["done", "done"]);
		// Merged into the workspace; no worktree is left, and git sees only the two new files.
		const [a, b] = started.map((out) => out.agent_id as string);
		expect(readFileSync(join(place.workspace, "docs/a.md"), "utf8")).toBe(`docs/a.md by ${a}\n`);
		expect(readFileSync(join(place.workspace, "docs/b.md"), "utf8")).toBe(`docs/b.md by ${b}\n`);
		const worktrees = join(place.workspace, ".fingers", "worktrees");
		expect(existsSync(worktrees) ? readdirSync(worktrees).filter((name) => name.startsWith("sub_")) : []).toEqual([]);
		expect(git(place.workspace, "status", "--porcelain").trim().split("\n").sort()).toEqual(["?? docs/"]);
		// The children's file changes reached the host under their ids.
		expect(
			m.outs
				.filter((out) => out.type === "file_changed")
				.map((out) => [out.agent_id, out.path])
				.sort(),
		).toEqual([
			[a, "docs/a.md"],
			[b, "docs/b.md"],
		]);
		expect(JSON.stringify(m.outs)).not.toContain(TOKEN);
	});

	it("keeps a sub-agent checkpoint over RPC and rolls its worktree and transcript back to it", async () => {
		const place = repository();
		const firstOfA = gate();
		const laterOfA = gate();
		cleanups.push(() => {
			firstOfA.open();
			laterOfA.open();
		});
		const m = await startManaged(place, async (agent, turn, body) => {
			if (agent === "main") {
				return turn === 0
					? tool("toolu_agents", "agents", { start: [{ label: "notes", task: "Write x.txt" }] })
					: text("Done.");
			}
			if (JSON.stringify(body.messages).includes("rolled you back to checkpoint"))
				return text("Went on from x.txt.");
			if (turn === 0) {
				await firstOfA.promise;
				return tool("toolu_x", "write", { path: "x.txt", content: "x\n" });
			}
			if (turn === 1) return tool("toolu_y", "write", { path: "y.txt", content: "y\n" });
			await laterOfA.promise;
			return text("Wrote x.txt and y.txt.");
		});
		await m.command({ type: "prompt", message: "Take notes with a sub-agent" });
		const [started] = await m.waitFor((out) => out.type === "subagent_started");
		const id = started.agent_id as string;
		// Its session exists (it announced its task) and waits for its first model answer.
		await m.waitFor((out) => out.type === "message_start" && out.agent_id === id);
		const path = join(place.root, "checkpoints", "cp_notes1.jsonl");
		const exporting = m.command({ type: "checkpoint_export", agent_id: id, path });
		await m.waitFor((out) => out.type === "subagent_updated" && out.agent_id === id && out.status === "paused");
		firstOfA.open();
		const exported = await exporting;
		expect(exported).toMatchObject({ success: true, data: { checkpoint: { id: "cp_notes1", agent_id: id } } });
		const checkpoint = exported.data.checkpoint;
		// The worktree got y.txt after the checkpoint; the child now waits for its third model answer.
		const worktree = join(place.workspace, started.worktree);
		await vi.waitFor(() => expect(existsSync(join(worktree, "y.txt"))).toBe(true), {
			timeout: 20_000,
			interval: 10,
		});
		const imported = await m.command({
			type: "checkpoint_import",
			agent_id: id,
			path,
			sha256: checkpoint.sha256,
			mode: "resume",
		});
		expect(imported).toMatchObject({ success: true, data: { mode: "resume", entry_id: checkpoint.entry_id } });
		const [result] = await m.waitFor((out) => out.type === "result");
		expect(result).toMatchObject({ status: "completed" });
		expect(m.outs.find((out) => out.type === "subagent_finished")).toMatchObject({
			agent_id: id,
			status: "done",
			summary: "Went on from x.txt.",
		});
		// Only what came before the checkpoint was merged.
		expect(readFileSync(join(place.workspace, "x.txt"), "utf8")).toBe("x\n");
		expect(existsSync(join(place.workspace, "y.txt"))).toBe(false);
		// The roll-back took the transcript back: the request after it has no y.txt step.
		const last = m.anthropic.requests.filter((request) => agentOf(request.body) === id).at(-1)!;
		expect(JSON.stringify(last.body.messages)).toContain("x.txt");
		expect(JSON.stringify(last.body.messages)).not.toContain("toolu_y");
		for (const out of m.outs) expect(validateOutbound(out), JSON.stringify(out).slice(0, 300)).toEqual([]);
	});

	it("starts no sub-agent when the repository root lies outside workspace.root", async () => {
		const place = repository("app");
		const m = await startManaged(place, (agent, turn) =>
			agent === "main" && turn === 0
				? tool("toolu_agents", "agents", { start: [{ label: "a", task: "Write a.txt" }] })
				: text("Could not start sub-agents."),
		);
		await m.command({ type: "prompt", message: "Go" });
		await m.waitFor((out) => out.type === "result");
		const end = m.outs.find((out) => out.type === "tool_execution_end" && out.toolName === "agents")!;
		expect(end.isError).toBe(true);
		expect(end.result.content[0].text).toContain(REPOSITORY_OUTSIDE_WORKSPACE);
		expect(m.outs.filter((out) => out.type === "subagent_started")).toEqual([]);
		expect(existsSync(join(place.repoRoot, ".fingers"))).toBe(false);
	});
});
