/**
 * Prompt caching through the whole agent (managed RPC mode, the way Hands runs Fingers): the real system
 * prompt, the real builtin tools, real tool calls and two prompts, with the real Anthropic provider against
 * a fake Messages API. Every request after the first must start with the previous request's bytes (cache
 * markers aside), keep the four breakpoints, and the cache usage must reach the host's usage events.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedRpcServer } from "../src/modes/rpc/managed/managed-rpc-server.ts";
import { createManagedRuntimeFactory } from "../src/modes/rpc/managed/managed-runtime.ts";
import { listen, type ScriptedResponse, startFakeAnthropic } from "./managed-rpc-fakes.ts";

type Rec = Record<string, any>;

const TRACE = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba90200-01";
const usage = { input: 310, output: 40, cacheRead: 9200, cacheWrite: 480 };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllEnvs();
});

async function startManaged(responses: ScriptedResponse[]) {
	vi.stubEnv("ANTHROPIC_API_KEY", "");
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fingers-cache-")));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "workspace");
	mkdirSync(workspace);
	writeFileSync(join(workspace, "app.ts"), "export const app = 1;\n");
	writeFileSync(join(workspace, "util.ts"), "export const util = 2;\n");
	const anthropic = startFakeAnthropic(responses);
	const baseUrl = await listen(anthropic.server);
	cleanups.push(() => new Promise<void>((resolve) => anthropic.server.close(() => resolve())));
	const outs: Rec[] = [];
	const server = new ManagedRpcServer({
		io: { writeStdout: (line) => outs.push(JSON.parse(line)), writeStderr: () => {} },
		createRuntime: createManagedRuntimeFactory({ agentDir: join(root, "agent"), sessionDir: join(root, "sessions") }),
		version: "0.1.0",
		env: "test",
	});
	cleanups.push(() => server.shutdown("test end"));
	server.start();
	let n = 0;
	const command = async (record: Rec): Promise<Rec> => {
		const id = `c${++n}`;
		await server.handleLine(JSON.stringify({ traceparent: TRACE, ...record, id }));
		await vi.waitFor(() => expect(outs.some((out) => out.type === "response" && out.id === id)).toBe(true), {
			timeout: 10_000,
			interval: 10,
		});
		return outs.find((out) => out.type === "response" && out.id === id)!;
	};
	const waitFor = async (type: string, count: number) => {
		await vi.waitFor(() => expect(outs.filter((out) => out.type === type).length).toBeGreaterThanOrEqual(count), {
			timeout: 15_000,
			interval: 10,
		});
		return outs.filter((out) => out.type === type);
	};
	expect(
		await command({
			type: "configure",
			run_id: "run_cache",
			request_id: "req_cache",
			workspace: { root: workspace, protected_paths: [] },
			model: { provider: "anthropic", model_id: "claude-sonnet-4-5" },
			tools: { approval: "never" },
		}),
	).toMatchObject({ success: true });
	expect(
		await command({
			type: "credentials",
			provider: "anthropic",
			base_url: baseUrl,
			credential_kind: "proxy_token",
			credential: "hpt_run_cache_q8Zr3vK1xYwT0b",
			expires_at: new Date(Date.now() + 3_600_000).toISOString(),
		}),
	).toMatchObject({ success: true });
	return { outs, command, waitFor, requests: anthropic.requests };
}

function stripMarkers(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripMarkers);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key !== "cache_control")
				.map(([key, nested]) => [key, stripMarkers(nested)]),
		);
	}
	return value;
}

function markedMessages(messages: Rec[]): number[] {
	return messages.flatMap((message, index) =>
		Array.isArray(message.content) && message.content.some((block: Rec) => block.cache_control) ? [index] : [],
	);
}

describe("prompt caching across agent turns", () => {
	it("keeps the cached prefix byte-identical and the breakpoints on the newest and previous turn", async () => {
		const m = await startManaged([
			{
				// Parallel tool calls: the turn that pushes the previous breakpoint furthest back.
				content: [
					{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "app.ts" } },
					{ type: "toolCall", id: "toolu_2", name: "read", arguments: { path: "util.ts" } },
				],
				usage,
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "Both files export one constant." }], usage, stopReason: "stop" },
			{
				content: [{ type: "toolCall", id: "toolu_3", name: "ls", arguments: { path: "." } }],
				usage,
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "Two files." }], usage, stopReason: "stop" },
		]);
		await m.command({ type: "prompt", message: "What do app.ts and util.ts export?" });
		await m.waitFor("result", 1);
		await m.command({ type: "prompt", message: "How many files are there?" });
		await m.waitFor("result", 2);

		const bodies = m.requests.map((request) => request.body);
		expect(bodies).toHaveLength(4);

		// The whole head of the prompt (tools, then system) is the same bytes on every request.
		const system = JSON.stringify(bodies[0].system);
		const tools = JSON.stringify(bodies[0].tools);
		expect(system).toContain("cache_control");
		expect(bodies[0].tools.length).toBeGreaterThan(3);
		for (const body of bodies) {
			expect(JSON.stringify(body.system)).toBe(system);
			expect(JSON.stringify(body.tools)).toBe(tools);
			expect(body.thread).toBeUndefined();
		}

		// Each request's messages start with every message of the previous request, byte for byte.
		for (let i = 1; i < bodies.length; i++) {
			const previous = bodies[i - 1].messages.map((message: Rec) => JSON.stringify(stripMarkers(message)));
			const current = bodies[i].messages.map((message: Rec) => JSON.stringify(stripMarkers(message)));
			expect(current.slice(0, previous.length), `request ${i + 1}`).toEqual(previous);
		}

		// Breakpoints: system + last tool + newest message, plus the previous request's last message.
		expect(markedMessages(bodies[0].messages)).toEqual([0]);
		for (let i = 1; i < bodies.length; i++) {
			const previousEnd = bodies[i - 1].messages.length - 1;
			const newest = bodies[i].messages.length - 1;
			expect(markedMessages(bodies[i].messages), `request ${i + 1}`).toEqual([previousEnd, newest]);
		}

		// Cache usage reaches the host per turn and in the run totals.
		const usageEvents = m.outs.filter((out) => out.type === "usage");
		expect(usageEvents).toHaveLength(4);
		for (const event of usageEvents) {
			expect(event.turn.tokens).toMatchObject({ cache_read_tokens: 9200, cache_write_tokens: 480 });
			expect(event.turn.cost_usd.cache_read).toBeGreaterThan(0);
		}
	});
});
