/**
 * Sub-agents in managed RPC mode (contracts/v1/fingers-rpc.md, Sub-agents, amendment 2026-11-27), with a
 * stand-in engine (the real one is ee: ee/test/managed-subagents.test.ts runs it end to end). The server announces
 * `subagents` only with an engine and offers the `agents` tool only after `configure.subagents.enabled`; children are
 * real sessions on the run's credentials under the managed gate (their worktree as the workspace, the protected
 * paths, the run's tools, approvals with their `agent_id`, correlation headers); their records reach the host with
 * their `agent_id` and none of a run's lifecycle; their usage counts toward the run's limits; `steer`, `abort` and
 * checkpoints with an `agent_id` reach only that child.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EeHost, EeModule } from "../src/core/edition/types.ts";
import {
	emptyUsage,
	type SubagentChild,
	type SubagentEngine,
	type SubagentInfo,
	type SubagentRunHost,
	type SubagentRunRequest,
	type SubagentRunResult,
} from "../src/core/subagents/types.ts";
import { combineUsage } from "../src/core/usage-totals.ts";
import { ApprovalBroker } from "../src/modes/rpc/managed/approvals.ts";
import { validateOutbound } from "../src/modes/rpc/managed/contract.ts";
import { ManagedRpcServer } from "../src/modes/rpc/managed/managed-rpc-server.ts";
import { createManagedRuntimeFactory } from "../src/modes/rpc/managed/managed-runtime.ts";
import {
	managedSubagentEngine,
	REPOSITORY_OUTSIDE_WORKSPACE,
	workspaceBoundEngine,
} from "../src/modes/rpc/managed/subagents.ts";
import { listen, type ScriptedResponse, startFakeAnthropic } from "./managed-rpc-fakes.ts";

type Rec = Record<string, any>;

const TOKEN = "hpt_run_test_sub4gentsQ8Zr3vK1";
const TRACE = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba90200-01";
const USAGE = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllEnvs();
});

function text(value: string): ScriptedResponse {
	return { content: [{ type: "text", text: value }], usage: USAGE, stopReason: "stop" };
}

function tool(id: string, name: string, args: Rec): ScriptedResponse {
	return { content: [{ type: "toolCall", id, name, arguments: args }], usage: USAGE, stopReason: "toolUse" };
}

/** Which agent asks: the rules at the end of a child's system prompt name it. */
function agentOf(body: Rec): string {
	return /You are sub-agent (sub_\d+)/.exec(JSON.stringify(body.system ?? ""))?.[1] ?? "main";
}

function turnOf(body: Rec): number {
	return (body.messages as Rec[]).filter((message) => message.role === "assistant").length;
}

/** A promise a test resolves later (a model answer held back until then). */
function gate(): { promise: Promise<void>; open: () => void } {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

/**
 * A stand-in for the ee engine: every child of a call starts at once in `.fingers/worktrees/<id>` under the parent's
 * directory, reports its lifecycle through the host, and stops when the host's limit is reached.
 */
class StandInEngine implements SubagentEngine {
	private seq = 0;
	readonly infos = new Map<string, SubagentInfo>();
	readonly children = new Map<string, SubagentChild>();
	private readonly checkpoints = new Map<string, string | null>();
	readonly rollBacks: string[] = [];
	readonly calls: SubagentRunRequest[] = [];
	private host?: SubagentRunHost;

	async run(request: SubagentRunRequest, host: SubagentRunHost): Promise<SubagentRunResult> {
		this.calls.push(request);
		this.host = host;
		const infos = request.agents.map((spec) => {
			const id = `sub_${++this.seq}`;
			const info: SubagentInfo = {
				id,
				parentId: "main",
				label: spec.label,
				task: spec.task,
				kind: spec.kind ?? "code",
				model: host.pickModel(spec.kind ?? "code"),
				worktree: `.fingers/worktrees/${id}`,
				dependsOn: [],
				status: "running",
				usage: emptyUsage(),
			};
			this.infos.set(id, info);
			host.report({ type: "subagent_started", agent: { ...info } });
			return info;
		});
		const stopAll = () => {
			for (const child of this.children.values()) child.abort();
		};
		await Promise.all(
			infos.map(async (info) => {
				const cwd = join(host.cwd, info.worktree!);
				mkdirSync(cwd, { recursive: true });
				const child = await host.startChild({
					id: info.id,
					label: info.label,
					task: info.task,
					cwd,
					model: info.model,
				});
				this.children.set(info.id, child);
				child.onUsage((usage) => {
					info.usage = usage;
					if (host.budgetReached(0)) stopAll();
				});
				child.onApproval((waiting) => {
					info.status = waiting ? "waiting_approval" : "running";
					host.report({ type: "subagent_updated", agent: { ...info } });
				});
				const outcome = await child.run();
				info.status = outcome.status;
				info.summary = outcome.summary;
				info.usage = child.usage();
				this.children.delete(info.id);
				host.report({ type: "subagent_finished", agent: { ...info } });
				child.dispose();
			}),
		);
		return {
			agents: infos,
			text: infos.map((info) => `${info.id} ${info.status}`).join("; "),
			usage: infos.reduce((sum, info) => combineUsage(sum, info.usage), emptyUsage()),
		};
	}

	steer(id: string, message: string): boolean {
		return this.children.get(id)?.steer(message) ?? false;
	}

	stop(id: string): boolean {
		const child = this.children.get(id);
		if (!child) return false;
		child.abort();
		return true;
	}

	list(): readonly SubagentInfo[] {
		return [...this.infos.values()];
	}

	pause(id: string): boolean {
		const child = this.children.get(id);
		if (!child?.pause()) return false;
		this.update(id, "paused");
		return true;
	}

	async resume(id: string, checkpoint?: string): Promise<void> {
		const child = this.children.get(id);
		if (!child) throw new Error(`${id} is not running`);
		if (checkpoint === undefined) {
			if (!child.resume()) throw new Error(`${id} is not paused`);
		} else {
			if (!this.checkpoints.has(checkpoint)) throw new Error(`${id} has no checkpoint ${checkpoint}`);
			this.rollBacks.push(checkpoint);
			await child.rollBack(this.checkpoints.get(checkpoint)!, `Rolled back to ${checkpoint}.`, async () => {});
		}
		this.update(id, "running");
	}

	async checkpoint(id: string) {
		const child = this.children.get(id);
		if (!child) throw new Error(`${id} is not running`);
		const cp = `cp-${this.checkpoints.size + 1}`;
		const position = await child.atRest(async (at) => at);
		this.checkpoints.set(cp, position);
		return { id: cp, at: Date.now() };
	}

	transcript() {
		return undefined;
	}

	async removeWorktree(): Promise<void> {}

	/** A status change outside the children's own events (pause, resume), reported like the real engine does. */
	private update(id: string, status: SubagentInfo["status"]): void {
		const info = this.infos.get(id);
		if (!info) return;
		info.status = status;
		this.host?.report({ type: "subagent_updated", agent: { ...info } });
	}
}

interface StartOptions {
	engine?: SubagentEngine;
	respond: (agent: string, turn: number, body: Rec) => ScriptedResponse | Promise<ScriptedResponse>;
}

async function startManaged(options: StartOptions) {
	vi.stubEnv("ANTHROPIC_API_KEY", "");
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fingers-managed-sub-")));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "workspace");
	mkdirSync(workspace);
	mkdirSync(join(root, "private"));
	writeFileSync(join(root, "private", "secret.txt"), "runner state");
	mkdirSync(join(root, "checkpoints"));
	const anthropic = startFakeAnthropic((body) => options.respond(agentOf(body), turnOf(body), body));
	const anthropicUrl = await listen(anthropic.server);
	cleanups.push(() => new Promise<void>((resolve) => anthropic.server.close(() => resolve())));
	cleanups.push(() => anthropic.server.closeAllConnections());
	const outs: Rec[] = [];
	const stderr: string[] = [];
	const server = new ManagedRpcServer({
		io: {
			writeStdout: (line) => outs.push(JSON.parse(line)),
			writeStderr: (line) => stderr.push(line),
		},
		createRuntime: createManagedRuntimeFactory({ agentDir: join(root, "agent"), sessionDir: join(root, "sessions") }),
		version: "0.1.0",
		env: "test",
		subagentEngine: options.engine ? () => options.engine : undefined,
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
	const send = (record: Rec) =>
		server.handleLine(JSON.stringify(record.type.endsWith("_response") ? record : { traceparent: TRACE, ...record }));
	const command = async (record: Rec): Promise<Rec> => {
		const id = record.id ?? `c${++n}`;
		await send({ ...record, id });
		await vi.waitFor(() => expect(outs.some((out) => out.type === "response" && out.id === id)).toBe(true), {
			timeout: 15_000,
			interval: 10,
		});
		return outs.find((out) => out.type === "response" && out.id === id)!;
	};
	const configure = (extra: Rec = {}) =>
		command({
			type: "configure",
			run_id: "run_sub",
			request_id: "req_sub",
			workspace: { root: workspace, protected_paths: [join(root, "private")] },
			model: { provider: "anthropic", model_id: "claude-sonnet-4-5" },
			checkpoints: { dir: join(root, "checkpoints") },
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
	const waitFor = async (predicate: (out: Rec) => boolean, count = 1) => {
		await vi.waitFor(() => expect(outs.filter(predicate).length).toBeGreaterThanOrEqual(count), {
			timeout: 15_000,
			interval: 10,
		});
		return outs.filter(predicate);
	};
	const type = (name: string) => (out: Rec) => out.type === name;
	return { root, workspace, server, outs, stderr, send, command, configure, credentials, waitFor, type, anthropic };
}

/** The two-child task: the main agent starts sub-agents a and b, each writes its file, then the main agent ends. */
function twoChildren(
	extra: (agent: string, turn: number, body: Rec) => ScriptedResponse | undefined = () => undefined,
): (agent: string, turn: number, body: Rec) => ScriptedResponse {
	return (agent, turn, body) => {
		const special = extra(agent, turn, body);
		if (special) return special;
		if (agent === "main") {
			return turn === 0
				? tool("toolu_agents", "agents", {
						start: [
							{ label: "a", task: "Write a.txt" },
							{ label: "b", task: "Write b.txt" },
						],
					})
				: text("Both parts are done.");
		}
		const file = agent === "sub_1" ? "a.txt" : "b.txt";
		return turn === 0
			? tool(`toolu_${agent}`, "write", { path: file, content: `${agent}\n` })
			: text(`${file} written.`);
	};
}

const LIFECYCLE = ["agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "result"];

describe("managed RPC sub-agents: the switch", () => {
	it("announces subagents only with an engine, refuses configure.subagents without one, and offers agents only when on", async () => {
		const without = await startManaged({ respond: () => text("ok") });
		expect(without.outs[0]!.capabilities).not.toContain("subagents");
		expect(await without.configure({ subagents: { enabled: true } })).toMatchObject({
			success: false,
			code: "unsupported",
		});

		const off = await startManaged({ engine: new StandInEngine(), respond: () => text("ok") });
		expect(off.outs[0]!.capabilities).toContain("subagents");
		expect(await off.configure()).toMatchObject({ success: true });
		await off.credentials();
		await off.command({ type: "prompt", message: "Hello" });
		await off.waitFor(off.type("result"));
		const offTools = (off.anthropic.requests[0]!.body.tools as Rec[]).map((t) => t.name);
		expect(offTools).not.toContain("agents");

		const on = await startManaged({ engine: new StandInEngine(), respond: () => text("ok") });
		expect(await on.configure({ subagents: { enabled: true } })).toMatchObject({ success: true });
		await on.credentials();
		await on.command({ type: "prompt", message: "Hello" });
		await on.waitFor(on.type("result"));
		const onTools = (on.anthropic.requests[0]!.body.tools as Rec[]).map((t) => t.name);
		expect(onTools).toContain("agents");
		const configured = on.stderr.map((line) => JSON.parse(line)).find((log) => log.msg === "configured");
		expect(configured).toMatchObject({ subagents: true });
	});
});

describe("managed RPC sub-agents: a run", () => {
	it("forwards the children's records with their agent_id, counts their usage, and keeps the run's lifecycle to main", async () => {
		const engine = new StandInEngine();
		const m = await startManaged({ engine, respond: twoChildren() });
		await m.configure({
			subagents: { enabled: true },
			tools: { builtin: ["read", "write", "ls"], approval: "never" },
		});
		await m.credentials();
		await m.command({ type: "prompt", message: "Write a.txt and b.txt with sub-agents" });
		const [result] = await m.waitFor(m.type("result"));

		for (const out of m.outs) expect(validateOutbound(out), JSON.stringify(out).slice(0, 300)).toEqual([]);
		// Lifecycle: started, finished, done.
		const started = m.outs.filter((out) => out.type === "subagent_started");
		expect(started.map((out) => [out.agent_id, out.parent_agent_id, out.label, out.status])).toEqual([
			["sub_1", "main", "a", "running"],
			["sub_2", "main", "b", "running"],
		]);
		expect(started[0]).toMatchObject({ worktree: ".fingers/worktrees/sub_1", depends_on: [] });
		const finished = m.outs.filter((out) => out.type === "subagent_finished");
		expect(finished.map((out) => [out.agent_id, out.status]).sort()).toEqual([
			["sub_1", "done"],
			["sub_2", "done"],
		]);
		// The children wrote in their own directories.
		expect(readFileSync(join(m.workspace, ".fingers/worktrees/sub_1/a.txt"), "utf8")).toBe("sub_1\n");
		expect(readFileSync(join(m.workspace, ".fingers/worktrees/sub_2/b.txt"), "utf8")).toBe("sub_2\n");
		// Their records carry their id; none of a run's lifecycle comes from them.
		const childRecords = m.outs.filter((out) => typeof out.agent_id === "string" && out.agent_id.startsWith("sub_"));
		const types = new Set(childRecords.map((out) => out.type));
		for (const expected of [
			"message_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"usage",
			"file_changed",
		]) {
			expect(types, expected).toContain(expected);
		}
		for (const lifecycle of LIFECYCLE) expect(types, lifecycle).not.toContain(lifecycle);
		expect(m.outs.filter((out) => out.type === "result")).toHaveLength(1);
		expect(m.outs.filter((out) => out.type === "agent_settled")).toHaveLength(1);
		// file_changed paths are relative to the child's copy of the workspace.
		expect(
			m.outs
				.filter((out) => out.type === "file_changed")
				.map((out) => [out.agent_id, out.path, out.change])
				.sort(),
		).toEqual([
			["sub_1", "a.txt", "added"],
			["sub_2", "b.txt", "added"],
		]);
		// A child's tool call starts before it ends, after its gate decided.
		const startIndex = m.outs.findIndex((out) => out.type === "tool_execution_start" && out.agent_id === "sub_1");
		const endIndex = m.outs.findIndex((out) => out.type === "tool_execution_end" && out.agent_id === "sub_1");
		expect(startIndex).toBeGreaterThan(-1);
		expect(endIndex).toBeGreaterThan(startIndex);
		// Usage: 6 model calls (main 2, each child 2), each counted once in the cumulative and the result.
		const usages = m.outs.filter((out) => out.type === "usage");
		expect(usages.map((out) => out.agent_id ?? "main").sort()).toEqual([
			"main",
			"main",
			"sub_1",
			"sub_1",
			"sub_2",
			"sub_2",
		]);
		expect(usages.at(-1)!.cumulative.tokens.input_tokens).toBe(600);
		expect(result).toMatchObject({ agent_id: "main", status: "completed", turns: 2 });
		expect(result.usage.tokens).toEqual({
			input_tokens: 600,
			output_tokens: 120,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
		});
		const childCost = finished.reduce((sum, out) => sum + out.usage.cost_usd.total, 0);
		expect(childCost).toBeCloseTo((result.usage.cost_usd.total * 4) / 6, 9);
		// The children got the run's tools only (no agents, browser or memory) and asked with the run's correlation.
		const childRequests = m.anthropic.requests.filter((request) => agentOf(request.body) !== "main");
		expect(childRequests).toHaveLength(4);
		for (const request of childRequests) {
			expect((request.body.tools as Rec[]).map((t) => t.name).sort()).toEqual(["ls", "read", "write"]);
			expect(request.headers["x-api-key"]).toBe(TOKEN);
			expect(request.headers.traceparent).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
			expect(request.headers["x-request-id"]).toBe("req_sub");
		}
		// The credential never leaves.
		expect(JSON.stringify(m.outs)).not.toContain(TOKEN);
		expect(m.stderr.join("")).not.toContain(TOKEN);
	});

	it("relays the children's spans under their agent_id, each child request carrying its own chat span", async () => {
		const m = await startManaged({ engine: new StandInEngine(), respond: twoChildren() });
		await m.configure({
			subagents: { enabled: true },
			tools: { builtin: ["read", "write", "ls"], approval: "never" },
			telemetry: { mode: "relay" },
		});
		await m.credentials();
		await m.command({ type: "prompt", message: "Write a.txt and b.txt with sub-agents" });
		await m.waitFor(m.type("result"));
		const spans = m.outs.filter((out) => out.type === "telemetry_span").map((out) => out.span as Rec);
		const chats = spans.filter((span) => span.attributes["gen_ai.operation.name"] === "chat");
		const byAgent = (agent: string) => chats.filter((span) => span.attributes["veyra.fingers.agent_id"] === agent);
		expect(byAgent("main")).toHaveLength(2);
		expect(byAgent("sub_1")).toHaveLength(2);
		expect(byAgent("sub_2")).toHaveLength(2);
		for (const span of spans) {
			expect(span.trace_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
			expect(span.attributes["veyra.run_id"]).toBe("run_sub");
		}
		for (const request of m.anthropic.requests) {
			const agent = agentOf(request.body);
			const spanId = String(request.headers.traceparent).split("-")[2];
			expect(
				byAgent(agent).map((span) => span.span_id),
				agent,
			).toContain(spanId);
		}
		expect(JSON.stringify(spans)).not.toContain(TOKEN);
	});

	it("asks the host for a child's approvals under its agent_id and keeps it inside its worktree", async () => {
		const engine = new StandInEngine();
		const m = await startManaged({
			engine,
			respond: twoChildren((agent, turn) => {
				// sub_2 tries to read the runner's protected state, then a file outside its worktree.
				if (agent === "sub_2" && turn === 0)
					return tool("toolu_p", "read", { path: "../../../../private/secret.txt" });
				if (agent === "sub_2" && turn === 1) return tool("toolu_o", "read", { path: "/etc/hosts" });
				if (agent === "sub_2" && turn === 2) return text("Could not read them.");
				return undefined;
			}),
		});
		await m.configure({ subagents: { enabled: true }, tools: { approval: "write_tools" } });
		await m.credentials();
		await m.command({ type: "prompt", message: "Go" });
		const [request] = await m.waitFor(m.type("approval_request"));
		expect(request).toMatchObject({
			agent_id: "sub_1",
			tool: { server: "builtin", name: "write" },
			kind: "file_write",
		});
		await m.waitFor(
			(out) => out.type === "subagent_updated" && out.agent_id === "sub_1" && out.status === "waiting_approval",
		);
		await m.send({ type: "approval_response", id: request.id, decision: "allow_once" });
		await m.waitFor(m.type("result"));
		expect(m.outs.find((out) => out.type === "approval_resolved")).toMatchObject({
			agent_id: "sub_1",
			id: request.id,
			decision: "allow_once",
		});
		const updates = m.outs
			.filter((out) => out.type === "subagent_updated" && out.agent_id === "sub_1")
			.map((out) => out.status);
		expect(updates).toEqual(["waiting_approval", "running"]);
		// The protected path and the path outside the worktree were refused without asking.
		const blocked = m.outs
			.filter((out) => out.type === "tool_execution_end" && out.agent_id === "sub_2")
			.map((out) => out.result.content[0].text);
		expect(blocked).toEqual(["Tool path targets protected runtime state", "Tool path is outside the workspace"]);
		expect(m.outs.filter((out) => out.type === "approval_request")).toHaveLength(1);
		for (const out of m.outs) expect(validateOutbound(out), JSON.stringify(out).slice(0, 300)).toEqual([]);
	});

	it("stops every child when a child's spend reaches the run's cost limit", async () => {
		const engine = new StandInEngine();
		const m = await startManaged({
			engine,
			// The children keep listing until they are stopped.
			respond: twoChildren((agent, turn) =>
				agent !== "main" ? tool(`toolu_${agent}_${turn}`, "ls", {}) : undefined,
			),
		});
		// Each call costs $0.0006: the main call and the first child call reach $0.001.
		await m.configure({
			subagents: { enabled: true },
			tools: { builtin: ["read", "write", "ls"], approval: "never" },
			limits: { max_cost_usd: 0.001 },
		});
		await m.credentials();
		await m.command({ type: "prompt", message: "Go" });
		const [result] = await m.waitFor(m.type("result"));
		expect(result).toMatchObject({ status: "stopped", stop_reason: "max_cost_reached" });
		expect(m.outs.filter((out) => out.type === "subagent_finished").map((out) => out.status)).toEqual([
			"stopped",
			"stopped",
		]);
		expect(m.outs.find((out) => out.type === "notice")).toMatchObject({ code: "limit_reached" });
		// The main agent made no call after the agents call returned, and the engine saw that one call only.
		expect(m.anthropic.requests.filter((request) => agentOf(request.body) === "main")).toHaveLength(1);
		expect(engine.calls).toHaveLength(1);
	});
});

describe("managed RPC sub-agents: steer, abort and checkpoints with an agent_id", () => {
	it("steers one child, stops another, refuses unknown ids, and the run completes", async () => {
		const engine = new StandInEngine();
		const firstOfA = gate();
		const m = await startManaged({
			engine,
			respond: async (agent, turn, body) => {
				if (agent === "sub_1" && turn === 0) {
					await firstOfA.promise;
					return tool("toolu_sub_1", "ls", {});
				}
				if (agent === "sub_1")
					return text(JSON.stringify(body.messages).includes("Use tabs") ? "Steered." : "Not steered.");
				// sub_2 waits until it is stopped.
				if (agent === "sub_2") return new Promise<ScriptedResponse>(() => {});
				return twoChildren()(agent, turn, body);
			},
		});
		cleanups.push(() => firstOfA.open());
		await m.configure({
			subagents: { enabled: true },
			tools: { builtin: ["read", "write", "ls"], approval: "never" },
		});
		await m.credentials();
		await m.command({ type: "prompt", message: "Go" });
		await m.waitFor(m.type("subagent_started"), 2);
		expect(await m.command({ type: "steer", agent_id: "sub_9", message: "Hi" })).toMatchObject({
			success: false,
			code: "not_found",
		});
		expect(
			await m.command({ type: "steer", agent_id: "sub_1", message: "Use tabs", message_id: "msg_1" }),
		).toMatchObject({
			success: true,
			data: { disposition: "queued" },
		});
		firstOfA.open();
		await m.waitFor((out) => out.type === "subagent_finished" && out.agent_id === "sub_1");
		expect(await m.command({ type: "abort", agent_id: "sub_2" })).toMatchObject({ success: true });
		const [result] = await m.waitFor(m.type("result"));
		expect(result).toMatchObject({ status: "completed" });
		expect(m.outs.find((out) => out.type === "subagent_finished" && out.agent_id === "sub_1")).toMatchObject({
			status: "done",
			summary: "Steered.",
		});
		expect(m.outs.find((out) => out.type === "subagent_finished" && out.agent_id === "sub_2")).toMatchObject({
			status: "stopped",
		});
		// Once it ended, it cannot be stopped again.
		expect(await m.command({ type: "abort", agent_id: "sub_2" })).toMatchObject({
			success: false,
			code: "not_found",
		});
	});

	it("exports a running child's checkpoint and rolls it back to it", async () => {
		const engine = new StandInEngine();
		const firstOfA = gate();
		const laterOfA = gate();
		const m = await startManaged({
			engine,
			respond: async (agent, turn, body) => {
				if (agent === "sub_1" && turn === 0) {
					await firstOfA.promise;
					return tool("toolu_sub_1", "ls", {});
				}
				if (agent === "sub_1" && JSON.stringify(body.messages).includes("Rolled back to"))
					return text("Went on after the roll-back.");
				if (agent === "sub_1") {
					await laterOfA.promise;
					return text("Finished without a roll-back.");
				}
				if (agent === "sub_2") return text("b done.");
				return twoChildren()(agent, turn, body);
			},
		});
		cleanups.push(() => {
			firstOfA.open();
			laterOfA.open();
		});
		await m.configure({
			subagents: { enabled: true },
			tools: { builtin: ["read", "write", "ls"], approval: "never" },
		});
		await m.credentials();
		await m.command({ type: "prompt", message: "Go" });
		await m.waitFor((out) => out.type === "message_start" && out.agent_id === "sub_1");
		const path = join(m.root, "checkpoints", "cp_sub1a.jsonl");
		// The child is held before its next model call: after its first call and its tool call.
		const exporting = m.command({ type: "checkpoint_export", agent_id: "sub_1", path, label: "after ls" });
		await m.waitFor((out) => out.type === "subagent_updated" && out.agent_id === "sub_1" && out.status === "paused");
		firstOfA.open();
		const exported = await exporting;
		expect(exported).toMatchObject({
			success: true,
			data: { checkpoint: { id: "cp_sub1a", agent_id: "sub_1", label: "after ls" } },
		});
		const checkpoint = exported.data.checkpoint;
		const content = readFileSync(path, "utf8");
		const lines = content
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines[0]).toMatchObject({ type: "session", id: checkpoint.session_id });
		expect(lines.at(-1)!.id).toBe(checkpoint.entry_id);
		expect(content).toContain("Write a.txt");
		expect(content).not.toContain(TOKEN);
		expect(m.outs.find((out) => out.type === "checkpoint_created")).toMatchObject({
			agent_id: "sub_1",
			checkpoint_id: "cp_sub1a",
			sha256: checkpoint.sha256,
			entry_id: checkpoint.entry_id,
		});
		// Held for the checkpoint, then running again.
		const statuses = m.outs
			.filter((out) => out.type === "subagent_updated" && out.agent_id === "sub_1")
			.map((out) => out.status);
		expect(statuses).toEqual(["paused", "running"]);

		// A wrong hash, the fork mode and another sub-agent are refused; the kept checkpoint rolls the child back.
		expect(
			await m.command({
				type: "checkpoint_import",
				agent_id: "sub_1",
				path,
				sha256: "0".repeat(64),
				mode: "resume",
			}),
		).toMatchObject({ success: false, code: "checksum_mismatch" });
		expect(
			await m.command({
				type: "checkpoint_import",
				agent_id: "sub_1",
				path,
				sha256: checkpoint.sha256,
				mode: "fork",
			}),
		).toMatchObject({ success: false, code: "invalid_command" });
		expect(
			await m.command({
				type: "checkpoint_import",
				agent_id: "sub_2",
				path,
				sha256: checkpoint.sha256,
				mode: "resume",
			}),
		).toMatchObject({ success: false, code: "not_found" });
		const imported = await m.command({
			type: "checkpoint_import",
			agent_id: "sub_1",
			path,
			sha256: checkpoint.sha256,
			mode: "resume",
		});
		expect(imported).toMatchObject({
			success: true,
			data: { session_id: checkpoint.session_id, mode: "resume", entry_id: checkpoint.entry_id },
		});
		expect(engine.rollBacks).toEqual(["cp-1"]);
		await m.waitFor(m.type("result"));
		expect(m.outs.find((out) => out.type === "subagent_finished" && out.agent_id === "sub_1")).toMatchObject({
			status: "done",
			summary: "Went on after the roll-back.",
		});
		// Once it ended, its checkpoint cannot be restored.
		expect(
			await m.command({
				type: "checkpoint_import",
				agent_id: "sub_1",
				path,
				sha256: checkpoint.sha256,
				mode: "resume",
			}),
		).toMatchObject({ success: false, code: "not_found" });
		for (const out of m.outs) expect(validateOutbound(out), JSON.stringify(out).slice(0, 300)).toEqual([]);
	});
});

describe("managed RPC sub-agents: the ee engine and the workspace", () => {
	it("activates the ee module with only sub-agents on, and checkpoints while the run configured them", () => {
		let host: EeHost | undefined;
		const engine = new StandInEngine();
		const module: EeModule = {
			apiVersion: 8,
			matrixVersion: "test",
			minimumTier: () => "medium",
			activate(received) {
				host = received;
				for (const feature of ["token_saving", "brain", "eyes", "org_hooks"] as const)
					expect(received.isOn(feature)).toBe(false);
				received.registerSubagentEngine("token_saving", new StandInEngine());
				if (received.isOn("subagents")) received.registerSubagentEngine("subagents", engine);
			},
		};
		let checkpoints = false;
		expect(managedSubagentEngine(module, () => checkpoints)).toBe(engine);
		expect(host!.isOn("checkpoints")).toBe(false);
		checkpoints = true;
		expect(host!.isOn("checkpoints")).toBe(true);
		expect(host!.veyraApi("brain")).toBeUndefined();
		expect(managedSubagentEngine(undefined, () => true)).toBeUndefined();
		const broken: EeModule = {
			...module,
			activate: () => {
				throw new Error("broken");
			},
		};
		expect(managedSubagentEngine(broken, () => true)).toBeUndefined();
	});

	it("refuses a call whose repository root lies outside the workspace before the engine runs", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "fingers-managed-repo-")));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
		const workspace = join(root, "app");
		mkdirSync(workspace);
		const inner = new StandInEngine();
		const run = vi.spyOn(inner, "run");
		const host = { cwd: workspace } as SubagentRunHost;
		const request = { toolCallId: "t", agents: [{ label: "a", task: "x" }] };
		await expect(workspaceBoundEngine(inner, () => workspace).run(request, host)).rejects.toThrow(
			REPOSITORY_OUTSIDE_WORKSPACE,
		);
		expect(run).not.toHaveBeenCalled();
		// A repository inside the workspace (here: the workspace is the repository) is fine.
		const roots: string[] = [];
		run.mockResolvedValue({ agents: [], text: "", usage: emptyUsage() });
		await workspaceBoundEngine(
			inner,
			() => root,
			(found) => roots.push(found),
		).run(request, host);
		expect(run).toHaveBeenCalledTimes(1);
		expect(roots).toEqual([root]);
	});
});

describe("managed approval broker and sub-agents", () => {
	it("cancels one agent's requests, resolves an aborted asker as cancelled, and names the agent", async () => {
		const records: Rec[] = [];
		let next = 0;
		const broker = new ApprovalBroker({
			emit: (record) => records.push(record),
			timeoutMs: 60_000,
			newId: () => `apr_${++next}`,
		});
		const bash = { server: "builtin", name: "bash", kind: "command" as const };
		const main = broker.request({ toolCallId: "t1", tool: bash, args: { command: "ls" }, reason: "r" });
		const child = broker.request({
			toolCallId: "t2",
			tool: bash,
			args: { command: "ls" },
			reason: "r",
			agentId: "sub_1",
		});
		const controller = new AbortController();
		const other = broker.request({
			toolCallId: "t3",
			tool: bash,
			args: { command: "ls" },
			reason: "r",
			agentId: "sub_2",
			signal: controller.signal,
		});
		broker.cancelAgent("sub_1");
		expect(await child).toEqual({ decision: "cancelled" });
		controller.abort();
		expect(await other).toEqual({ decision: "cancelled" });
		expect(broker.pendingCount).toBe(1);
		broker.respond({ id: "apr_1", decision: "allow_once" });
		expect(await main).toMatchObject({ decision: "allow_once" });
		expect(records.filter((record) => record.type === "approval_resolved")).toEqual([
			{ type: "approval_resolved", agent_id: "sub_1", id: "apr_2", decision: "cancelled" },
			{ type: "approval_resolved", agent_id: "sub_2", id: "apr_3", decision: "cancelled" },
			{ type: "approval_resolved", id: "apr_1", decision: "allow_once" },
		]);
		expect(records.filter((record) => record.type === "approval_request").map((record) => record.agent_id)).toEqual([
			undefined,
			"sub_1",
			"sub_2",
		]);
		const aborted = new AbortController();
		aborted.abort();
		expect(
			await broker.request({
				toolCallId: "t4",
				tool: bash,
				args: {},
				reason: "r",
				agentId: "sub_3",
				signal: aborted.signal,
			}),
		).toEqual({ decision: "cancelled" });
	});
});
