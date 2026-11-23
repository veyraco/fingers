/**
 * Managed RPC mode with the contract's `openai-compatible` provider: Fingers builds the model from
 * `configure.model.model_id` and `credentials.base_url`, with no catalog or models.json entry.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { validateOutbound } from "../src/modes/rpc/managed/contract.ts";
import { ManagedRpcServer } from "../src/modes/rpc/managed/managed-rpc-server.ts";
import { createManagedRuntimeFactory } from "../src/modes/rpc/managed/managed-runtime.ts";
import { OPENAI_COMPATIBLE_PROVIDER, openAICompatibleProvider } from "../src/modes/rpc/managed/openai-compatible.ts";
import { listen, type ScriptedResponse, startFakeOpenAI } from "./managed-rpc-fakes.ts";

type Rec = Record<string, any>;

const TOKEN = "hpt_run_test_oaic_7Kd2pQ9xVb";
const TRACE = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba90200-01";
const MODEL_ID = "custom-model-1";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fingers-oaic-")));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

async function startManaged(responses: ScriptedResponse[] = []) {
	const root = tempDir();
	const workspace = join(root, "workspace");
	mkdirSync(workspace);
	const agentDir = join(root, "agent");
	const openai = startFakeOpenAI(responses);
	// The host's endpoint under a path prefix, like the Hands model proxy's `<proxy>/openai`.
	const baseUrl = `${await listen(openai.server)}/openai`;
	cleanups.push(() => new Promise<void>((resolve) => openai.server.close(() => resolve())));
	const outs: Rec[] = [];
	const server = new ManagedRpcServer({
		io: { writeStdout: (line) => outs.push(JSON.parse(line)), writeStderr: () => {} },
		createRuntime: createManagedRuntimeFactory({ agentDir, sessionDir: join(root, "sessions") }),
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
	const configure = (model: Rec = { provider: OPENAI_COMPATIBLE_PROVIDER, model_id: MODEL_ID }) =>
		command({ type: "configure", run_id: "run_test", workspace: { root: workspace }, model });
	const credentials = (extra: Rec = {}) =>
		command({
			type: "credentials",
			provider: OPENAI_COMPATIBLE_PROVIDER,
			base_url: baseUrl,
			credential_kind: "proxy_token",
			credential: TOKEN,
			...extra,
		});
	const state = async () => (await command({ type: "get_state" })).data as Rec;
	return { agentDir, baseUrl, outs, openai, command, configure, credentials, state };
}

describe("managed RPC openai-compatible provider", () => {
	it("configures the model from configure and credentials alone, with no catalog or models.json entry", async () => {
		const m = await startManaged();
		expect(await m.configure()).toMatchObject({ success: true, data: { session_id: expect.any(String) } });
		expect((await m.state()).model).toMatchObject({
			provider: OPENAI_COMPATIBLE_PROVIDER,
			id: MODEL_ID,
			api: "openai-completions",
			baseUrl: "",
		});

		expect(await m.credentials()).toMatchObject({ success: true, data: { provider: OPENAI_COMPATIBLE_PROVIDER } });
		expect((await m.state()).model).toMatchObject({
			provider: OPENAI_COMPATIBLE_PROVIDER,
			id: MODEL_ID,
			api: "openai-completions",
			baseUrl: m.baseUrl,
		});
		// The host writes nothing into Fingers' agent directory, and Fingers needs nothing there.
		expect(existsSync(join(m.agentDir, "models.json"))).toBe(false);
		for (const out of m.outs) expect(validateOutbound(out), JSON.stringify(out)).toEqual([]);
	});

	it("sends the model request to base_url with the configured model id and the host's credential", async () => {
		const m = await startManaged([
			{
				content: [{ type: "text", text: "hello" }],
				usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
			},
		]);
		await m.configure();
		await m.credentials();
		expect(await m.command({ type: "prompt", message: "hi" })).toMatchObject({
			success: true,
			data: { disposition: "started" },
		});
		await vi.waitFor(() => expect(m.outs.some((out) => out.type === "result")).toBe(true), {
			timeout: 15_000,
			interval: 10,
		});

		expect(m.openai.requests).toHaveLength(1);
		const [request] = m.openai.requests;
		expect(request.path).toBe("/openai/chat/completions");
		expect(request.body).toMatchObject({ model: MODEL_ID, stream: true });
		expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
		expect(m.outs.find((out) => out.type === "result")).toMatchObject({
			status: "completed",
			text: "hello",
			usage: { tokens: { input_tokens: 100, output_tokens: 20 } },
		});
		// No list price: the host counts the cost.
		expect(m.outs.find((out) => out.type === "usage")).toMatchObject({
			provider: OPENAI_COMPATIBLE_PROVIDER,
			model: MODEL_ID,
			cost_source: "unknown",
			turn: { tokens: { input_tokens: 100, output_tokens: 20 }, cost_usd: { total: 0 } },
		});
		for (const out of m.outs) expect(validateOutbound(out), JSON.stringify(out)).toEqual([]);
	});

	it("sends no request before a base_url arrives", async () => {
		const m = await startManaged();
		expect(await m.configure()).toMatchObject({ success: true });
		expect(await m.command({ type: "prompt", message: "hi" })).toMatchObject({
			success: false,
			code: "credentials_missing",
			error: expect.stringContaining(OPENAI_COMPATIBLE_PROVIDER),
		});
		const withoutBaseUrl = {
			type: "credentials",
			provider: OPENAI_COMPATIBLE_PROVIDER,
			credential_kind: "proxy_token",
			credential: TOKEN,
		};
		expect(await m.command(withoutBaseUrl)).toMatchObject({
			success: false,
			code: "invalid_command",
			error: expect.stringContaining("base_url"),
		});
		expect(m.openai.requests).toHaveLength(0);
	});

	it("keeps resolving built-in providers from the catalog and fails configure on an unknown provider", async () => {
		const catalog = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const m = await startManaged();
		expect(await m.configure({ provider: "no-such-provider", model_id: MODEL_ID })).toMatchObject({
			success: false,
			code: "invalid_command",
			error: expect.stringContaining(`Unknown model: no-such-provider/${MODEL_ID}`),
		});
		expect(await m.configure({ provider: "anthropic", model_id: "claude-sonnet-4-5" })).toMatchObject({
			success: true,
		});
		const model = (await m.state()).model;
		expect(model).toMatchObject({ provider: "anthropic", id: "claude-sonnet-4-5", api: "anthropic-messages" });
		expect(model).toEqual(JSON.parse(JSON.stringify(catalog.getModel("anthropic", "claude-sonnet-4-5"))));
	});
});

describe("openAICompatibleProvider", () => {
	function capturingFetch() {
		const urls: string[] = [];
		const fetch: typeof globalThis.fetch = async (input, init) => {
			urls.push(new Request(input, init).url);
			return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		return { fetch, urls };
	}

	it("fails a request while the model has no base URL instead of using a default endpoint", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			extraProviders: [openAICompatibleProvider(MODEL_ID)],
		});
		await runtime.setRuntimeApiKey(OPENAI_COMPATIBLE_PROVIDER, TOKEN);
		const model = runtime.getModel(OPENAI_COMPATIBLE_PROVIDER, MODEL_ID)!;
		const { fetch, urls } = capturingFetch();
		const result = await runtime.completeSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{ fetch },
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(
			`No base URL for ${OPENAI_COMPATIBLE_PROVIDER}/${MODEL_ID}: the host names the endpoint in credentials.base_url`,
		);
		expect(urls).toEqual([]);
	});

	it("builds the same model as a models.json custom OpenAI-compatible model", async () => {
		const baseUrl = "https://llm.example.com/v1";
		const modelsPath = join(tempDir(), "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: { "my-endpoint": { baseUrl, api: "openai-completions", models: [{ id: MODEL_ID }] } },
			}),
		);
		const fromModelsJson = (await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath })).getModel(
			"my-endpoint",
			MODEL_ID,
		);

		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			extraProviders: [openAICompatibleProvider(MODEL_ID)],
		});
		// What `credentials` does with base_url.
		runtime.registerProvider(OPENAI_COMPATIBLE_PROVIDER, { baseUrl });
		const built = runtime.getModel(OPENAI_COMPATIBLE_PROVIDER, MODEL_ID);
		expect(fromModelsJson).toBeDefined();
		expect({ ...built, provider: "my-endpoint" }).toEqual(fromModelsJson);
	});
});
