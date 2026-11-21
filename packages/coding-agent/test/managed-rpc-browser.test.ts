/**
 * The `browser` built-in tool in managed RPC mode: the `browser` capability, `configure.network`, and
 * approvals of kind `network`. The run with a real browser is skipped when none is installed.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findBrowserExecutable } from "../src/core/browser/browser-session.ts";
import { allowAlwaysPattern, approvalNeed, describeManagedTool } from "../src/modes/rpc/managed/approvals.ts";
import { ManagedRpcServer } from "../src/modes/rpc/managed/managed-rpc-server.ts";
import { createManagedRuntimeFactory } from "../src/modes/rpc/managed/managed-runtime.ts";
import { listen, type ScriptedResponse, startFakeAnthropic } from "./managed-rpc-fakes.ts";

type Rec = Record<string, any>;

const TRACE = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba90200-01";
const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 };
const realBrowser = findBrowserExecutable();

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllEnvs();
});

async function startManaged(responses: ScriptedResponse[]) {
	vi.stubEnv("ANTHROPIC_API_KEY", "");
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fingers-managed-browser-")));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const workspace = join(root, "workspace");
	mkdirSync(workspace);
	const anthropic = startFakeAnthropic(responses);
	const anthropicUrl = await listen(anthropic.server);
	cleanups.push(() => new Promise<void>((resolve) => anthropic.server.close(() => resolve())));
	const outs: Rec[] = [];
	const stderr: string[] = [];
	const server = new ManagedRpcServer({
		io: { writeStdout: (line) => outs.push(JSON.parse(line)), writeStderr: (line) => stderr.push(line) },
		createRuntime: createManagedRuntimeFactory({ agentDir: join(root, "agent"), sessionDir: join(root, "sessions") }),
		version: "0.1.0",
		env: "test",
	});
	cleanups.push(() => server.shutdown("test end"));
	server.start();
	let n = 0;
	const send = (record: Rec) =>
		server.handleLine(JSON.stringify(record.type.endsWith("_response") ? record : { traceparent: TRACE, ...record }));
	const command = async (record: Rec): Promise<Rec> => {
		const id = `c${++n}`;
		await send({ ...record, id });
		await vi.waitFor(() => expect(outs.some((out) => out.type === "response" && out.id === id)).toBe(true), {
			timeout: 30_000,
			interval: 10,
		});
		return outs.find((out) => out.type === "response" && out.id === id)!;
	};
	const waitFor = async (type: string, count = 1) => {
		await vi.waitFor(() => expect(outs.filter((out) => out.type === type).length).toBeGreaterThanOrEqual(count), {
			timeout: 45_000,
			interval: 20,
		});
		return outs.filter((out) => out.type === type);
	};
	const configure = (extra: Rec = {}) =>
		command({
			type: "configure",
			run_id: "run_browser",
			request_id: "req_browser",
			workspace: { root: workspace },
			model: { provider: "anthropic", model_id: "claude-sonnet-4-5" },
			...extra,
		});
	const credentials = () =>
		command({
			type: "credentials",
			provider: "anthropic",
			base_url: anthropicUrl,
			credential_kind: "proxy_token",
			credential: "hpt_run_test_q8Zr3vK1xYwT0b",
			expires_at: new Date(Date.now() + 3_600_000).toISOString(),
		});
	return { outs, stderr, send, command, configure, credentials, waitFor, anthropic };
}

describe("browser approvals", () => {
	it("navigate, click, type and evaluate are network calls; reading the page is not", () => {
		for (const action of ["navigate", "click", "type", "evaluate"]) {
			const tool = describeManagedTool("browser", [], { action });
			expect(tool).toEqual({ server: "builtin", name: "browser", kind: "network" });
			expect(approvalNeed(tool, "write_tools")).toEqual({ required: true, reason: "Network access" });
		}
		for (const action of ["text", "screenshot", "close"]) {
			expect(describeManagedTool("browser", [], { action }).kind).toBe("other");
		}
		const navigate = describeManagedTool("browser", [], { action: "navigate" });
		expect(allowAlwaysPattern(navigate, { action: "navigate", url: "https://Docs.Example.com:8443/a?b" })).toBe(
			"browser navigate docs.example.com",
		);
		expect(
			allowAlwaysPattern(describeManagedTool("browser", [], { action: "evaluate" }), { action: "evaluate" }),
		).toBe("browser evaluate");
	});
});

describe("managed RPC browser capability", () => {
	it("announces browser only when a browser executable is found, and configure refuses it otherwise", async () => {
		vi.stubEnv("FINGERS_BROWSER_PATH", "/nonexistent/chromium");
		const m = await startManaged([]);
		const hello = m.outs.find((out) => out.type === "hello")!;
		expect(hello.capabilities).not.toContain("browser");
		const refused = await m.configure({ tools: { builtin: ["read", "browser"] } });
		expect(refused).toMatchObject({ success: false, code: "invalid_command" });
		expect(refused.error).toMatch(/browser/);
	});

	it("announces browser when FINGERS_BROWSER_PATH names an executable", async () => {
		vi.stubEnv("FINGERS_BROWSER_PATH", process.execPath);
		const m = await startManaged([]);
		expect(m.outs.find((out) => out.type === "hello")!.capabilities).toContain("browser");
	});

	it("a denied navigation never starts the browser or reaches the host", async () => {
		vi.stubEnv("FINGERS_BROWSER_PATH", process.execPath);
		const hits: string[] = [];
		const site = createServer((req, res) => {
			hits.push(String(req.url));
			res.end("x");
		});
		const siteUrl = await listen(site);
		cleanups.push(() => new Promise<void>((resolve) => site.close(() => resolve())));
		const m = await startManaged([
			{
				content: [
					{
						type: "toolCall",
						id: "toolu_nav",
						name: "browser",
						arguments: { action: "navigate", url: `${siteUrl}/a` },
					},
				],
				usage,
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "Not allowed." }], usage, stopReason: "stop" },
		]);
		expect(await m.configure({ tools: { builtin: ["read", "browser"], approval: "write_tools" } })).toMatchObject({
			success: true,
		});
		await m.credentials();
		await m.command({ type: "prompt", message: "open the site" });
		const [request] = await m.waitFor("approval_request");
		expect(request).toMatchObject({
			kind: "network",
			tool: { server: "builtin", name: "browser" },
			summary: `browser navigate ${siteUrl}/a`,
			reason: "Network access",
			allow_always_pattern: "browser navigate 127.0.0.1",
		});
		await m.send({ type: "approval_response", id: request.id, decision: "deny", reason: "no browsing" });
		await m.waitFor("result");
		expect(m.outs.find((out) => out.type === "tool_execution_end")).toMatchObject({ isError: true });
		expect(hits).toEqual([]);
		expect(m.stderr.join("\n")).not.toContain("browser started");
	});
});

describe.skipIf(!realBrowser)("managed RPC browser run with a real browser", () => {
	it("opens an allowed page after approval and blocks a host outside configure.network", async () => {
		const outsideHits: string[] = [];
		const outside = createServer((req, res) => {
			outsideHits.push(String(req.url));
			res.end("outside");
		});
		const outsideUrl = await listen(outside);
		cleanups.push(() => new Promise<void>((resolve) => outside.close(() => resolve())));
		const site = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/html" }).end(
				`<title>Run page</title><p>Managed browsing works</p><img src="${outsideUrl}/pixel">`,
			);
		});
		const siteUrl = await listen(site);
		cleanups.push(() => new Promise<void>((resolve) => site.close(() => resolve())));
		const sitePort = (site.address() as AddressInfo).port;
		const m = await startManaged([
			{
				content: [
					{
						type: "toolCall",
						id: "toolu_nav",
						name: "browser",
						arguments: { action: "navigate", url: `${siteUrl}/` },
					},
				],
				usage,
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "toolu_text", name: "browser", arguments: { action: "text" } }],
				usage,
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "Read it." }], usage, stopReason: "stop" },
		]);
		await m.configure({
			tools: { builtin: ["read", "browser"], approval: "write_tools" },
			network: { mode: "allow_list", hosts: [`127.0.0.1:${sitePort}`] },
		});
		await m.credentials();
		await m.command({ type: "prompt", message: "read the run page" });
		const [request] = await m.waitFor("approval_request");
		await m.send({ type: "approval_response", id: request.id, decision: "allow_once" });
		const [result] = await m.waitFor("result");
		expect(result).toMatchObject({ status: "completed" });
		// Only the navigation asked; reading the page did not.
		expect(m.outs.filter((out) => out.type === "approval_request")).toHaveLength(1);
		const ends = m.outs.filter((out) => out.type === "tool_execution_end");
		const nav = ends.find((out) => out.toolCallId === "toolu_nav")!;
		expect(nav.isError).toBe(false);
		expect(nav.result.content[0].text).toContain("Title: Run page");
		expect(nav.result.content[0].text).toContain(`${new URL(outsideUrl).host} (not in the run's network allow list)`);
		const text = ends.find((out) => out.toolCallId === "toolu_text")!;
		expect(text.result.content[0].text).toContain("Managed browsing works");
		expect(outsideHits).toEqual([]);
		const logs = m.stderr.map((line) => JSON.parse(line));
		const started = logs.find((line) => line.msg === "browser started");
		expect(started).toMatchObject({ run_id: "run_browser", request_id: "req_browser", network_mode: "allow_list" });
		expect(logs.find((line) => line.msg === "browser request blocked")).toMatchObject({ run_id: "run_browser" });
	}, 90_000);
});
