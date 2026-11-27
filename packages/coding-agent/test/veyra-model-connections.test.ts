/**
 * The organization's model connections in Fingers, against a fake Connect that also plays Hands' model proxy
 * door for the Fingers CLI (hands.yaml "Model calls from the Fingers CLI").
 *
 * - Only connections open to both fingers and hands, with a provider Hands relays, for the person's group, are
 *   offered; Connect's refusal of the list is a clear error.
 * - A model call goes to `<api>/hands/v1/model-proxy/{connection}/{wire}/…` with the person's Hands token as
 *   `Authorization: Bearer` and no key; the fake Hands adds the provider key upstream.
 * - Hands' refusals (models:use, cli:use, cost caps) reach the person as clear errors.
 * - Nothing is written: no file gets the provider key or a token, and no credential is stored for the providers.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	createProvider,
	isRetryableAssistantError,
	type Model,
	type Provider,
	type TranscriptContext,
} from "@veyraco/fingers-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemorySecretStore } from "../src/core/os-keychain.ts";
import {
	connectionErrorText,
	createConnectionProvider,
	fingersOffline,
	namesModelConnection,
	prepareModelConnections,
	VeyraModelConnections,
} from "../src/core/veyra/connection-provider.ts";
import {
	classifyModelConnections,
	fetchModelConnections,
	ModelConnectionsError,
	modelConnectionsSummary,
	PROXY_ROUTES,
	parseModelConnections,
} from "../src/core/veyra/model-connections.ts";
import { VeyraApiError } from "../src/core/veyra/oidc-client.ts";
import { openVeyraSessionVault } from "../src/core/veyra/session-vault.ts";
import { VeyraAuth } from "../src/core/veyra/veyra-auth.ts";
import { createVeyraLog } from "../src/core/veyra/veyra-log.ts";
import { listen, startFakeAnthropic, startFakeOpenAI } from "./managed-rpc-fakes.ts";
import { FakeConnect } from "./veyra-fake-connect.ts";

/** What Fingers writes to files while `recording` (node:fs and node:fs/promises writes), as text. */
const writes = vi.hoisted(() => ({ recording: false, data: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const text = (data: unknown) =>
		typeof data === "string"
			? data
			: Buffer.isBuffer(data) || data instanceof Uint8Array
				? Buffer.from(data).toString("utf-8")
				: String(data);
	const wrap =
		<F extends (...args: any[]) => any>(fn: F) =>
		(...args: Parameters<F>): ReturnType<F> => {
			if (writes.recording) writes.data.push(text(args[1]));
			return fn(...args);
		};
	const promises = {
		...actual.promises,
		writeFile: wrap(actual.promises.writeFile),
		appendFile: wrap(actual.promises.appendFile),
	};
	const patched = {
		...actual,
		writeFileSync: wrap(actual.writeFileSync),
		appendFileSync: wrap(actual.appendFileSync),
		promises,
	};
	return { ...patched, default: patched };
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const text = (data: unknown) =>
		typeof data === "string"
			? data
			: Buffer.isBuffer(data) || data instanceof Uint8Array
				? Buffer.from(data).toString("utf-8")
				: String(data);
	const wrap =
		<F extends (...args: any[]) => any>(fn: F) =>
		(...args: Parameters<F>): ReturnType<F> => {
			if (writes.recording) writes.data.push(text(args[1]));
			return fn(...args);
		};
	const patched = { ...actual, writeFile: wrap(actual.writeFile), appendFile: wrap(actual.appendFile) };
	return { ...patched, default: patched };
});

let fake: FakeConnect | undefined;
let agentDir: string;
const servers: Array<{ close(callback?: () => void): unknown; closeAllConnections?(): void }> = [];

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "fingers-veyra-models-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	writes.recording = false;
	await fake?.stop();
	fake = undefined;
	for (const server of servers.splice(0)) {
		server.closeAllConnections?.();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	rmSync(agentDir, { recursive: true, force: true });
});

const CLAUDE = {
	id: "mc_claude",
	provider: "anthropic",
	name: "Claude",
	key_hint: "sk-ant-…9dQx",
	apps: ["hands", "fingers"],
	groups: [],
	capabilities: ["chat"],
	status: "ok",
	created_at: "2026-11-26T10:00:00Z",
};
const ROUTER = {
	...CLAUDE,
	id: "mc_router",
	provider: "openrouter",
	name: "Router",
	groups: ["grp_editor"],
};
const NOT_FOR_FINGERS = { ...CLAUDE, id: "mc_intel", name: "Intelligence only", apps: ["hands", "intelligence"] };
const NOT_FOR_HANDS = { ...CLAUDE, id: "mc_nohands", name: "No Hands", apps: ["fingers"] };
const BEDROCK = { ...CLAUDE, id: "mc_bedrock", provider: "anthropic_bedrock", name: "Anthropic on Bedrock" };
const ADMINS_ONLY = { ...CLAUDE, id: "mc_admins", name: "Admins", groups: ["grp_admin"] };
const REJECTED = { ...CLAUDE, id: "mc_rejected", name: "Old key", status: "key_rejected" };
/** Connect's answer for a subscription sign-in (connect src/models/views.ts connectionBody): no key hint. */
const CLAUDE_MAX = {
	id: "mc_claude_max",
	provider: "anthropic",
	auth: "subscription",
	account: "ada@acme.example",
	name: "Claude Max",
	apps: ["hands", "fingers"],
	groups: [],
	capabilities: ["chat"],
	models: ["claude-sonnet-4-5", "claude-opus-4-1"],
	status: "ok",
	created_at: "2026-11-26T10:00:00Z",
};
const CHATGPT = { ...CLAUDE_MAX, id: "mc_chatgpt", provider: "openai", name: "ChatGPT Pro" };
const SUPERGROK = { ...CLAUDE_MAX, id: "mc_grok", provider: "xai", name: "SuperGrok" };
const KIMI_CODE = { ...CLAUDE_MAX, id: "mc_kimi", provider: "kimi", name: "Kimi Code" };

async function startFake(): Promise<FakeConnect> {
	fake = await new FakeConnect({ resources: ["connect", "hands"] }).start();
	return fake;
}

async function signedIn(connect: FakeConnect): Promise<VeyraAuth> {
	const auth = new VeyraAuth({
		issuer: connect.issuer,
		vault: openVeyraSessionVault({
			agentDir,
			issuer: connect.issuer,
			env: { FINGERS_CREDENTIAL_STORE: "keychain" },
			secretStore: new InMemorySecretStore(),
		}),
		apiUrl: connect.issuer,
		appVersion: "0.1.0",
		log: createVeyraLog({ path: join(agentDir, "veyra.log"), version: "0.1.0", env: "test" }),
		sleep: async () => {},
	});
	await auth.login({ onCode: () => {}, signal: new AbortController().signal });
	return auth;
}

async function runtime(): Promise<ModelRuntime> {
	return ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, allowModelNetwork: false });
}

function userContext(text: string) {
	return { messages: [{ role: "user" as const, content: text, timestamp: Date.now() }] };
}

function fakeAnthropic(text = "hello from the connection") {
	const upstream = startFakeAnthropic([
		{
			content: [{ type: "text", text }],
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
			stopReason: "stop",
		},
	]);
	servers.push(upstream.server);
	return upstream;
}

function doorRequests(connect: FakeConnect) {
	return connect.requests.filter((request) => request.path.startsWith("/hands/v1/model-proxy/"));
}

/** Every file under the agent dir, as text. */
function filesUnder(dir: string): Array<{ name: string; text: string }> {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => ({ name: entry.name, text: readFileSync(join(entry.parentPath, entry.name), "utf-8") }));
}

describe("which connections Fingers offers", () => {
	it("offers only connections open to fingers and hands, relayed by Hands, for the person's group", async () => {
		const connect = await startFake();
		connect.filterConnectionsByApp = false;
		connect.modelConnections = [CLAUDE, ROUTER, NOT_FOR_FINGERS, NOT_FOR_HANDS, BEDROCK, ADMINS_ONLY, REJECTED];
		const auth = await signedIn(connect);

		const list = await fetchModelConnections(auth);

		expect(list.org).toBe("org_7aR2cT");
		expect(list.offered.map((entry) => [entry.providerId, entry.route.wire, entry.displayName])).toEqual([
			["veyra-mc_claude", "anthropic", "Claude (Veyra)"],
			["veyra-mc_router", "openai", "Router (Veyra)"],
		]);
		expect(list.notOffered.map((entry) => [entry.connection.id, entry.reason])).toEqual([
			["mc_intel", "not_for_fingers"],
			["mc_nohands", "not_for_hands"],
			["mc_bedrock", "provider"],
			["mc_admins", "group"],
			["mc_rejected", "key_rejected"],
		]);
		// Connect's list for Fingers, with the person's token for Connect.
		const [request] = connect.requestsTo("/connect/v1/organizations/org_7aR2cT/model-connections");
		expect(request?.method).toBe("GET");
		expect(connect.refreshesByAudience.get("connect")).toBe(1);
		expect(modelConnectionsSummary(list)).toEqual({
			ok: true,
			text: "2 model connections from Connect: Claude, Router",
		});
	});

	it("asks Connect for chat connections Fingers may use, and Connect's filter leaves the others out", async () => {
		const connect = await startFake();
		connect.modelConnections = [CLAUDE, NOT_FOR_FINGERS];
		const auth = await signedIn(connect);

		const list = await fetchModelConnections(auth);

		const [request] = connect.requestsTo("/connect/v1/organizations/org_7aR2cT/model-connections");
		expect(request?.search).toBe("?app=fingers&capability=chat");
		const token = String(request?.headers.authorization).replace(/^Bearer /, "");
		expect(connect.issuedSecrets).toContain(token);
		expect(list.offered.map((entry) => entry.connection.id)).toEqual(["mc_claude"]);
		expect(list.notOffered).toEqual([]);
	});

	it("a group without models:read gets a clear error from the list", async () => {
		const connect = await startFake();
		connect.modelConnectionsAnswer = {
			status: 403,
			body: { status: 403, code: "permission_denied", title: "You need models:read." },
		};
		const auth = await signedIn(connect);
		await auth.organization();

		const error = await fetchModelConnections(auth).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ModelConnectionsError);
		expect((error as Error).message).toBe(
			"Your group (Editor) in Acme Robotics may not see model connections (Connect models:read). Ask an admin of the organization.",
		);
	});

	it("says why no connection is usable", () => {
		const parsed = parseModelConnections({ data: [BEDROCK, NOT_FOR_HANDS, { name: "no id" }] });
		const classified = classifyModelConnections(parsed, { group: "grp_editor" });
		expect(modelConnectionsSummary(classified)).toEqual({
			ok: false,
			text: "No model connection from Connect is usable here: Anthropic on Bedrock (provider not relayed yet), No Hands (not open to Hands, which relays the calls).",
		});
		expect(modelConnectionsSummary({ offered: [], notOffered: [] }).text).toBe(
			"No model connection in Connect is open to Fingers yet: an admin adds fingers and hands to a connection’s apps.",
		);
	});

	it("offers a Claude subscription, but not subscriptions Hands relays to API-key endpoints", () => {
		const parsed = parseModelConnections({
			data: [CLAUDE_MAX, CHATGPT, SUPERGROK, KIMI_CODE, { ...CLAUDE, id: "mc_future", auth: "workload_identity" }],
		});
		expect(parsed[0]).toMatchObject({ auth: "subscription", models: ["claude-sonnet-4-5", "claude-opus-4-1"] });
		// A list without `auth` (an older Connect) means API keys.
		expect(parseModelConnections({ data: [CLAUDE] })[0]).toMatchObject({ auth: "api_key", models: [] });

		const classified = classifyModelConnections(parsed, { group: "grp_editor" });

		expect(classified.offered.map((entry) => entry.providerId)).toEqual(["veyra-mc_claude_max"]);
		expect(classified.notOffered.map((entry) => [entry.connection.id, entry.reason])).toEqual([
			["mc_chatgpt", "subscription"],
			["mc_grok", "subscription"],
			["mc_kimi", "subscription"],
			["mc_future", "subscription"],
		]);
		expect(modelConnectionsSummary({ offered: [], notOffered: classified.notOffered.slice(0, 1) }).text).toBe(
			"No model connection from Connect is usable here: ChatGPT Pro (its subscription sign-in is not relayed yet).",
		);
	});

	it("names from Connect can't reach the terminal with escapes", () => {
		const classified = classifyModelConnections(
			parseModelConnections({ data: [{ ...CLAUDE, name: "Evil\u001b]52;c;eA==\u0007" }] }),
			{},
		);
		expect(classified.offered[0]?.displayName).not.toMatch(/[\u0000-\u001f]/);
		expect(modelConnectionsSummary(classified).text).not.toMatch(/[\u0000-\u001f]/);
	});
});

describe("model calls through Hands' proxy", () => {
	it("sends the person's Hands token to the connection's proxy address, never a key, and answers as the connection", async () => {
		const connect = await startFake();
		connect.modelConnections = [CLAUDE];
		const upstream = fakeAnthropic();
		connect.handsUpstream = await listen(upstream.server);
		const auth = await signedIn(connect);
		const models = await runtime();
		const connections = new VeyraModelConnections();
		await connections.load(auth);
		expect(await connections.applyNow(models)).toEqual(["veyra-mc_claude"]);
		expect(models.hasConfiguredAuth("veyra-mc_claude")).toBe(true);

		const model = models.getModels("veyra-mc_claude")[0]!;
		expect(model.baseUrl).toBe(`${connect.issuer}/hands/v1/model-proxy/mc_claude/anthropic`);
		expect(models.getModels("veyra-mc_claude").map((entry) => entry.id)).toEqual(
			models.getModels("anthropic").map((entry) => entry.id),
		);
		const result = await models.complete(model, userContext("hi"));

		expect(result.stopReason).toBe("stop");
		expect(result.provider).toBe("veyra-mc_claude");
		expect(result.content).toEqual([{ type: "text", text: "hello from the connection" }]);
		const [door] = doorRequests(connect);
		expect(door?.path).toBe("/hands/v1/model-proxy/mc_claude/anthropic/v1/messages");
		const token = String(door?.headers.authorization).replace(/^Bearer /, "");
		expect(connect.issuedSecrets).toContain(token);
		expect(door?.headers["x-api-key"]).toBeUndefined();
		// An API-key connection is called the API-key way: no subscription betas, no Claude Code identity.
		expect(String(door?.headers["anthropic-beta"] ?? "")).not.toContain("oauth-2025-04-20");
		expect(JSON.stringify(upstream.requests[0]?.body.system ?? "")).not.toContain("You are Claude Code");
		expect(connect.refreshesByAudience.get("hands")).toBe(1);
		// Only Hands adds the key.
		expect(upstream.requests[0]?.headers["x-api-key"]).toBe(connect.handsProviderKey);
		// No credential of any kind is stored for the connection.
		expect((await models.listCredentials()).map((entry) => entry.providerId)).toEqual([]);
	});

	it("speaks OpenAI's wire for an OpenRouter connection, with the token as its bearer key", async () => {
		const connect = await startFake();
		connect.modelConnections = [ROUTER];
		const upstream = startFakeOpenAI([
			{
				content: [{ type: "text", text: "routed" }],
				usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
			},
		]);
		servers.push(upstream.server);
		connect.handsUpstream = await listen(upstream.server);
		const auth = await signedIn(connect);
		const models = await runtime();
		const connections = new VeyraModelConnections();
		await connections.load(auth);
		await connections.applyNow(models);

		const model = models.getModels("veyra-mc_router").find((entry) => entry.api === "openai-completions")!;
		const result = await models.complete(model, userContext("hi"));

		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "routed" }]);
		const [door] = doorRequests(connect);
		expect(door?.path).toBe("/hands/v1/model-proxy/mc_router/openai/chat/completions");
		expect(connect.issuedSecrets).toContain(String(door?.headers.authorization).replace(/^Bearer /, ""));
	});

	it("calls a Claude subscription connection as a Claude subscription, with the person's Hands token", async () => {
		const connect = await startFake();
		connect.modelConnections = [CLAUDE_MAX];
		const upstream = fakeAnthropic("hello from the subscription");
		connect.handsUpstream = await listen(upstream.server);
		const auth = await signedIn(connect);
		const models = await runtime();
		const connections = new VeyraModelConnections();
		await connections.load(auth);
		expect(await connections.applyNow(models)).toEqual(["veyra-mc_claude_max"]);
		const model = models.getModels("veyra-mc_claude_max").find((entry) => entry.id === "claude-sonnet-4-5")!;
		const tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };

		const result = await models.complete(model, {
			systemPrompt: "Be brief.",
			...userContext("hi"),
			tools: [tool],
		} as never);

		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "hello from the subscription" }]);
		const [door] = doorRequests(connect);
		expect(door?.path).toBe("/hands/v1/model-proxy/mc_claude_max/anthropic/v1/messages");
		// The subscription betas reach the door (and Hands passes them on); the marker key does not.
		const betas = String(door?.headers["anthropic-beta"]).split(",");
		expect(betas).toEqual(expect.arrayContaining(["oauth-2025-04-20", "claude-code-20250219"]));
		expect(upstream.requests[0]?.headers["anthropic-beta"]).toBe(door?.headers["anthropic-beta"]);
		const token = String(door?.headers.authorization).replace(/^Bearer /, "");
		expect(connect.issuedSecrets).toContain(token);
		expect(door?.headers["x-api-key"]).toBeUndefined();
		expect(JSON.stringify(door?.headers)).not.toContain("sk-ant-oat");
		// Anthropic requires the Claude Code identity first and Claude Code's tool names of a subscription token.
		const body = upstream.requests[0]!.body as { system: Array<{ text: string }>; tools: Array<{ name: string }> };
		expect(body.system[0]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
		expect(body.system.map((block) => block.text)).toContain("Be brief.");
		expect(body.tools.map((entry) => entry.name)).toEqual(["Read"]);
		expect((await models.listCredentials()).map((entry) => entry.providerId)).toEqual([]);
	});

	it("tells a provider's refusal of the connection's credential from Hands refusing the sign-in", async () => {
		const connect = await startFake();
		connect.modelConnections = [CLAUDE];
		const upstream = startFakeAnthropic([
			{
				content: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "error",
				error: {
					status: 401,
					body: JSON.stringify({
						type: "error",
						error: { type: "authentication_error", message: "invalid x-api-key" },
					}),
				},
			},
		]);
		servers.push(upstream.server);
		connect.handsUpstream = await listen(upstream.server);
		const auth = await signedIn(connect);
		const models = await runtime();
		const connections = new VeyraModelConnections();
		await connections.load(auth);
		await connections.applyNow(models);
		const model = models.getModels("veyra-mc_claude")[0]!;

		const byProvider = await models.complete(model, userContext("hi"));
		expect(byProvider.errorMessage).toBe(
			"Veyra model connection “Claude”: the provider refused the connection's key or sign-in (invalid x-api-key). Ask an admin of your organization to test the connection in Connect.",
		);

		// Hands' own 401 (hands proxy.ts: the token was rejected), with its realm.
		connect.handsRefusal = {
			status: 401,
			headers: { "www-authenticate": 'Bearer realm="hands", error="invalid_token"' },
			body: {
				type: "error",
				error: { type: "authentication_error", message: "The access token was rejected (member_suspended)." },
			},
		};
		const byHands = await models.complete(model, userContext("hi"));
		expect(byHands.errorMessage).toBe(
			"Veyra model connection “Claude”: Hands did not take your Veyra sign-in (The access token was rejected (member_suspended).). Run fingers login again.",
		);
	});

	it("a group without models:use gets a clear error, which is not retried", async () => {
		const connect = await startFake();
		connect.modelConnections = [CLAUDE];
		// Hands' answer when Connect refuses the lease (hands server/src/model-proxy/proxy.ts personLease).
		connect.handsRefusal = {
			status: 403,
			body: {
				type: "error",
				error: {
					type: "permission_error",
					message:
						"Connect refused this model connection: your group may not use it (Connect models:use, or the connection's groups).",
				},
			},
		};
		const auth = await signedIn(connect);
		const models = await runtime();
		const connections = new VeyraModelConnections();
		await connections.load(auth);
		await connections.applyNow(models);

		const result = await models.complete(models.getModels("veyra-mc_claude")[0]!, userContext("hi"));

		expect(result.stopReason).toBe("error");
		expect(result.provider).toBe("veyra-mc_claude");
		expect(result.errorMessage).toBe(
			"Veyra model connection “Claude”: refused (Connect refused this model connection: your group may not use it (Connect models:use, or the connection's groups).). Ask an admin of your organization in Connect: using a connection from Fingers needs Fingers cli:use and Connect models:use for your group, and the connection open to fingers and hands.",
		);
		expect(isRetryableAssistantError(result)).toBe(false);
	});

	it("a reached cost cap says so, and a signed-out Fingers says to sign in", async () => {
		const connect = await startFake();
		connect.modelConnections = [CLAUDE];
		connect.handsRefusal = {
			status: 403,
			body: {
				type: "error",
				error: {
					type: "max_cost_reached",
					message: "Stopped: your daily model cost cap for the Fingers CLI is reached.",
				},
			},
		};
		const auth = await signedIn(connect);
		const models = await runtime();
		const connections = new VeyraModelConnections();
		await connections.load(auth);
		await connections.applyNow(models);
		const model = models.getModels("veyra-mc_claude")[0]!;

		const capped = await models.complete(model, userContext("hi"));
		expect(capped.errorMessage).toBe(
			"Veyra model connection “Claude”: Stopped: your daily model cost cap for the Fingers CLI is reached.",
		);

		await auth.logout();
		const signedOut = await models.complete(model, userContext("hi"));
		expect(signedOut.stopReason).toBe("error");
		expect(signedOut.errorMessage).toBe(
			"Veyra model connection “Claude”: Not signed in to Veyra. Run fingers login.",
		);
	});

	it("writes neither the provider key nor any token anywhere", async () => {
		const connect = await startFake();
		connect.modelConnections = [CLAUDE];
		const upstream = fakeAnthropic();
		connect.handsUpstream = await listen(upstream.server);
		writes.data = [];
		writes.recording = true;

		const auth = await signedIn(connect);
		const models = await runtime();
		const connections = new VeyraModelConnections();
		await connections.load(auth);
		await connections.applyNow(models);
		const result = await models.complete(models.getModels("veyra-mc_claude")[0]!, userContext("hi"));
		expect(result.stopReason).toBe("stop");

		writes.recording = false;
		const secrets = [connect.handsProviderKey, ...connect.issuedSecrets];
		// The spy sees writes (the sign-in marker, veyra.log), none of which holds a secret.
		expect(writes.data.length).toBeGreaterThan(0);
		for (const text of [...writes.data, ...filesUnder(agentDir).map((file) => file.text)]) {
			for (const secret of secrets) expect(text).not.toContain(secret);
		}
		// The key stayed with Hands: Fingers never saw it.
		for (const request of connect.requests) {
			expect(JSON.stringify(request.headers)).not.toContain(connect.handsProviderKey);
		}
	});
});

describe("the connection provider", () => {
	/** A built-in provider stub that records what it got and answers as itself. */
	function stubBuiltin(
		seen: Array<{ model: Model<Api>; context: TranscriptContext; headers: unknown; apiKey: unknown }>,
	) {
		const answer = (
			model: Model<Api>,
			context: TranscriptContext,
			options?: { headers?: unknown; apiKey?: string },
		) => {
			seen.push({ model, context, headers: options?.headers, apiKey: options?.apiKey });
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message } as AssistantMessageEvent);
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
			});
			return stream;
		};
		const model: Model<"anthropic-messages"> = {
			id: "claude-test",
			name: "Claude test",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		} as Model<"anthropic-messages">;
		const provider: Provider = createProvider({
			id: "anthropic",
			auth: { apiKey: { name: "key", resolve: async () => undefined } },
			models: [model],
			api: { stream: answer as never, streamSimple: answer as never },
		});
		return { provider, model };
	}

	it("runs requests under the built-in provider's id and answers under the connection's", async () => {
		const seen: Array<{ model: Model<Api>; context: TranscriptContext; headers: unknown; apiKey: unknown }> = [];
		const { provider: builtin, model } = stubBuiltin(seen);
		const [offered] = classifyModelConnections(parseModelConnections({ data: [CLAUDE] }), {}).offered;
		const provider = createConnectionProvider({
			offered: offered!,
			handsApiBaseUrl: "https://api.veyra.localhost/hands/v1",
			models: [model],
			token: async () => "hands-token",
			builtin,
		})!;
		const connectionModel = provider.getModels()[0]!;
		expect(connectionModel.provider).toBe("veyra-mc_claude");

		const earlier: AssistantMessage = {
			...(await provider.stream(connectionModel, userContext("one") as unknown as TranscriptContext).result()),
		};
		expect(earlier.provider).toBe("veyra-mc_claude");
		const second = await provider
			.stream(connectionModel, {
				messages: [...userContext("one").messages, earlier, ...userContext("two").messages],
			} as unknown as TranscriptContext)
			.result();

		expect(second.provider).toBe("veyra-mc_claude");
		expect(seen.map((call) => call.model.provider)).toEqual(["anthropic", "anthropic"]);
		expect(seen[1]!.model.baseUrl).toBe("https://api.veyra.localhost/hands/v1/model-proxy/mc_claude/anthropic");
		// The earlier answer reaches the built-in code as its own, so its thinking and cache handling apply.
		expect(seen[1]!.context.messages.find((message) => message.role === "assistant")?.provider).toBe("anthropic");
		expect(seen[1]!.headers).toEqual({ Authorization: "Bearer hands-token" });
		expect(seen[1]!.apiKey).toBeUndefined();
	});

	it("passes errors other than refusals unchanged, so retries still read them", () => {
		expect(
			connectionErrorText(
				"Claude",
				'529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
			),
		).toBeUndefined();
		expect(connectionErrorText("Claude", "503 Hands can't reach Connect")).toBeUndefined();
		// A 401 whose answer the call did not see: Hands' own texts are Hands', anything else is the provider's.
		expect(
			connectionErrorText(
				"Claude",
				'401 {"type":"error","error":{"type":"authentication_error","message":"The access token is not valid."}}',
			),
		).toContain("Hands did not take your Veyra sign-in");
		expect(
			connectionErrorText(
				"Claude",
				'401 {"type":"error","error":{"type":"authentication_error","message":"The access token is not valid."}}',
				"provider",
			),
		).toContain("the provider refused the connection's key or sign-in");
		expect(
			connectionErrorText(
				"Claude",
				'401 {"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}',
			),
		).toContain("the provider refused the connection's key or sign-in");
		// A status inside the body is not the answer's.
		expect(connectionErrorText("Claude", '400 {"error":{"message":"request 403 too long"}}')).toBeUndefined();
		expect(
			connectionErrorText(
				"Claude",
				'404 {"type":"error","error":{"type":"not_found_error","message":"No such model connection in this organization."}}',
			),
		).toBe(
			"Veyra model connection “Claude”: No such model connection in this organization.. It may have been removed in Connect; run /model to pick another.",
		);
	});

	it("covers every provider Hands relays with a Fingers built-in provider", async () => {
		const models = await runtime();
		for (const route of Object.values(PROXY_ROUTES)) {
			expect(models.getModels(route.fingersProvider).length, route.fingersProvider).toBeGreaterThan(0);
		}
	});
});

describe("start and sign-out", () => {
	it("asks Connect at start only when the start names a Veyra connection, and registers it before a model is picked", async () => {
		const connect = await startFake();
		connect.modelConnections = [CLAUDE];
		const auth = await signedIn(connect);
		const connections = new VeyraModelConnections();

		const notNeeded = await runtime();
		expect(
			await prepareModelConnections(notNeeded, { auth: () => auth, wanted: false, offline: false }, connections),
		).toBeUndefined();
		expect(connect.requestsTo("/connect/v1/organizations/org_7aR2cT/model-connections")).toEqual([]);
		expect(notNeeded.getModels("veyra-mc_claude")).toEqual([]);

		const offline = await runtime();
		await prepareModelConnections(offline, { auth: () => auth, wanted: true, offline: true }, connections);
		expect(connect.requestsTo("/connect/v1/organizations/org_7aR2cT/model-connections")).toEqual([]);

		const needed = await runtime();
		expect(
			await prepareModelConnections(needed, { auth: () => auth, wanted: true, offline: false }, connections),
		).toBeUndefined();
		expect(needed.hasConfiguredAuth("veyra-mc_claude")).toBe(true);
		expect(needed.getModels("veyra-mc_claude").length).toBeGreaterThan(0);
		// Runtimes seen before the list arrived get it too, and a later one (/new) without asking again.
		expect(notNeeded.getModels("veyra-mc_claude").length).toBeGreaterThan(0);
		const later = await runtime();
		await prepareModelConnections(later, { auth: () => auth, wanted: true, offline: false }, connections);
		expect(later.hasConfiguredAuth("veyra-mc_claude")).toBe(true);
		expect(connect.requestsTo("/connect/v1/organizations/org_7aR2cT/model-connections")).toHaveLength(1);

		connections.clear();
		expect(needed.getModels("veyra-mc_claude")).toEqual([]);
		expect(later.getModels("veyra-mc_claude")).toEqual([]);
	});

	it("a sign-in to another organization drops the previous organization's connections, also when its list fails", async () => {
		let org = "org_7aR2cT";
		let answer: () => Promise<unknown> = async () => ({ data: [CLAUDE] });
		const auth = {
			account: () => ({ org, group: "grp_editor" }) as never,
			listModelConnections: () => answer(),
			apiBaseUrl: () => "https://api.veyra.localhost/hands/v1",
			getAccessToken: async () => "hands-token",
		};
		const models = await runtime();
		const connections = new VeyraModelConnections();
		await connections.load(auth);
		connections.apply(models);
		expect(models.getModels("veyra-mc_claude").length).toBeGreaterThan(0);

		org = "org_9Zb4Qe";
		answer = async () => {
			throw new VeyraApiError(503, "unavailable", "Down");
		};
		await expect(connections.load(auth)).rejects.toBeInstanceOf(ModelConnectionsError);

		expect(connections.list).toBeUndefined();
		expect(models.getModels("veyra-mc_claude")).toEqual([]);
	});

	it("a start whose Connect can't answer says so and goes on", async () => {
		const connect = await startFake();
		connect.modelConnectionsAnswer = { status: 503, body: { status: 503, code: "unavailable", title: "Down" } };
		const auth = await signedIn(connect);
		const warning = await prepareModelConnections(
			await runtime(),
			{ auth: () => auth, wanted: true, offline: false },
			new VeyraModelConnections(),
		);
		expect(warning).toBe(
			"Veyra model connections not loaded: Connect could not list model connections (503 unavailable: Down).",
		);
	});

	it("reads FINGERS_OFFLINE as main.ts does: 0 or empty is not offline", () => {
		expect(fingersOffline({ FINGERS_OFFLINE: "1" })).toBe(true);
		expect(fingersOffline({ FINGERS_OFFLINE: "TRUE" })).toBe(true);
		expect(fingersOffline({ FINGERS_OFFLINE: "yes" })).toBe(true);
		expect(fingersOffline({ FINGERS_OFFLINE: "0" })).toBe(false);
		expect(fingersOffline({ FINGERS_OFFLINE: "" })).toBe(false);
		expect(fingersOffline({})).toBe(false);
	});

	it("recognises Veyra connection references", () => {
		expect(namesModelConnection(["veyra-mc_claude"])).toBe(true);
		expect(namesModelConnection([undefined, "veyra-mc_claude/claude-sonnet-4-5"])).toBe(true);
		expect(namesModelConnection(["anthropic", "sonnet,veyra-mc_x/*"])).toBe(true);
		expect(namesModelConnection(["anthropic/claude-veyra-x", undefined])).toBe(false);
	});
});
