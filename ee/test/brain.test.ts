// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * Brain memory: the Brain provider against a mock of Brain's public API built from its contract
 * (veyraco/platform contracts/openapi/brain.yaml 1.0.0-rc.1: assembleContext, recall, remember,
 * reportLearningEvents on `subject:project:<repository>`), the feature through the real gate and core (on only with a
 * tier that includes Brain, a sign-in and a repository; otherwise a quiet no-op), a whole session against the mock,
 * and `/memory`.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { EeCommandContext, EeEntitlement, EeVeyraApi } from "@veyraco/fingers";
import { fauxAssistantMessage, getCurrentTools, type Message } from "@veyraco/fingers-ai";
import { compile, type JsonSchema } from "@veyraco/fingers-schema";
import { formats } from "@veyraco/fingers-schema/formats";
import { afterEach, describe, expect, it } from "vitest";
import { EditionGate } from "../../packages/coding-agent/src/core/edition/gate.ts";
import { MemoryProviders } from "../../packages/coding-agent/src/core/memory/registry.ts";
import { createBuiltinMemoryExtension } from "../../packages/coding-agent/src/extensions/memory/index.ts";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.ts";
import { BrainMemoryProvider, repositorySpace } from "../src/brain/index.ts";
import * as ee from "../src/index.ts";

// ---------------------------------------------------------------------------------------------------------
// The contract mock: request bodies are checked against brain.yaml's schemas (closed here, so a stray field such as
// a space or an organization fails), answers are shaped like brain.yaml's.
// ---------------------------------------------------------------------------------------------------------

const externalRef = {
	type: "object",
	required: ["app", "type", "id"],
	properties: { app: { type: "string" }, type: { type: "string" }, id: { type: "string" }, url: { type: "string" } },
	additionalProperties: false,
} as const;
const memoryType = { enum: ["fact", "preference", "episode", "procedure"] } as const;

const BODY_SCHEMAS: Record<string, JsonSchema> = {
	context: {
		type: "object",
		required: ["task", "max_tokens"],
		properties: {
			task: { type: "string", minLength: 1, maxLength: 20000 },
			max_tokens: { type: "integer", minimum: 50, maximum: 200000 },
			session_id: { type: "string" },
			types: { type: "array", items: memoryType },
			min_confidence: { type: "number", minimum: 0, maximum: 1 },
			format: { enum: ["markdown", "xml", "items_only"] },
			run_ref: externalRef,
			record_use: { type: "boolean" },
		},
		additionalProperties: false,
	},
	recall: {
		type: "object",
		required: ["query"],
		properties: {
			query: { type: "string", minLength: 1, maxLength: 8000 },
			types: { type: "array", items: memoryType },
			tags: { type: "array", items: { type: "string" } },
			limit: { type: "integer", minimum: 1, maximum: 100 },
			min_confidence: { type: "number", minimum: 0, maximum: 1 },
			session_id: { type: "string" },
			record_use: { type: "boolean" },
		},
		additionalProperties: false,
	},
	memories: {
		type: "object",
		required: ["type", "text"],
		properties: {
			type: memoryType,
			text: { type: "string", minLength: 1, maxLength: 8000 },
			importance: { enum: ["low", "normal", "high"] },
			confidence: { type: "number", minimum: 0, maximum: 1 },
			tags: { type: "array", items: { type: "string" } },
			pinned: { type: "boolean" },
			refs: { type: "array", items: externalRef },
			valid_until: { type: "string", format: "date-time" },
			dedupe: { type: "boolean" },
		},
		additionalProperties: false,
	},
	events: {
		type: "object",
		required: ["events"],
		properties: {
			events: {
				type: "array",
				minItems: 1,
				maxItems: 500,
				items: {
					type: "object",
					required: ["id", "kind", "at"],
					properties: {
						id: { type: "string" },
						kind: { enum: ["run_event", "outcome", "correction", "conversation_turn"] },
						at: { type: "string", format: "date-time" },
						session_id: { type: "string" },
						ref: externalRef,
						text: { type: "string", maxLength: 20000 },
						outcome: {
							type: "object",
							required: ["status"],
							properties: {
								status: { enum: ["succeeded", "failed", "reversed", "abandoned"] },
								summary: { type: "string", maxLength: 2000 },
							},
							additionalProperties: false,
						},
						corrects_memory_id: { type: "string" },
						data: { type: "object" },
					},
					additionalProperties: false,
				},
			},
		},
		additionalProperties: false,
	},
};
const validators = Object.fromEntries(
	Object.entries(BODY_SCHEMAS).map(([op, schema]) => [op, compile(schema, { formats })]),
) as Record<string, ReturnType<typeof compile>>;

const TOKEN = "eyJ.brain-token.sig";
const REPO = "github.com/acme/web";
const ORG = "org_acme";
const ROUTE = /^\/brain\/v1\/spaces\/([^/]+)\/(context|recall|memories|events)$/;

interface BrainRequest {
	op: string;
	space: string;
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

function problem(status: number, code: string, title: string) {
	return { status, body: { type: `https://docs.veyra.so/errors/${code}`, title, status, code } };
}

/** Brain with one space per subject, created on the first write; reads of a subject with no space answer 404. */
function startBrain(options: { failWith?: { status: number; body: unknown } } = {}) {
	const requests: BrainRequest[] = [];
	const spaces = new Map<string, string[]>();
	const server = createServer(async (request, response) => {
		const send = (status: number, body: unknown, type = "application/json") => {
			response.writeHead(status, { "content-type": type }).end(JSON.stringify(body));
		};
		const match = (request.url ?? "").match(ROUTE);
		if (request.method !== "POST" || !match) return send(404, problem(404, "not_found", "Not found").body);
		const space = decodeURIComponent(match[1]!);
		const op = match[2]!;
		const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
		requests.push({ op, space, headers: request.headers, body });
		if (request.headers.authorization !== `Bearer ${TOKEN}`)
			return send(401, problem(401, "unauthenticated", "Unauthenticated").body);
		if (!validators[op]!.check(body)) {
			const errors = validators[op]!.errors(body).map((error) => `${error.path}: ${error.message}`);
			return send(400, { ...problem(400, "invalid_request", "Invalid request").body, detail: errors.join("; ") });
		}
		if (options.failWith) return send(options.failWith.status, options.failWith.body, "application/problem+json");
		const items = spaces.get(space);
		switch (op) {
			case "context":
				if (!items) return send(404, problem(404, "not_found", "Not found").body);
				return send(200, {
					context: items.map((item) => `- ${item}`).join("\n"),
					tokens: 12,
					budget: body.max_tokens,
					items: [],
				});
			case "recall":
				if (!items) return send(404, problem(404, "not_found", "Not found").body);
				return send(200, {
					data: items.map((item, index) => ({ ref: `lt_${index + 1} v1`, kind: "fact", text: item, score: 0.9 })),
				});
			case "memories": {
				const list = items ?? [];
				list.push(String(body.text));
				spaces.set(space, list);
				return send(201, {
					id: `lt_${list.length}`,
					space_id: "sp_web",
					type: body.type,
					text: body.text,
					confidence: 0.9,
					importance: "normal",
					version: 1,
					pinned: false,
					created_at: "2026-11-26T00:00:00Z",
				});
			}
			default:
				if (!items) spaces.set(space, []);
				return send(202, { accepted: (body.events as unknown[]).length, duplicates: 0 });
		}
	});
	return { server, requests, spaces };
}

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function brain(options: Parameters<typeof startBrain>[0] = {}) {
	const mock = startBrain(options);
	const url = await listen(mock.server);
	cleanups.push(() => new Promise<void>((resolve) => mock.server.close(() => resolve())));
	const api: EeVeyraApi = { app: "brain", baseUrl: `${url}/brain/v1`, org: ORG, accessToken: async () => TOKEN };
	return { ...mock, url, api };
}

// ---------------------------------------------------------------------------------------------------------

describe("Brain provider against the contract mock", () => {
	it("works on the repository's project space as the signed-in person", async () => {
		const mock = await brain();
		const provider = new BrainMemoryProvider({ api: mock.api, org: ORG, repository: REPO, scope: "web" });
		// No memory of the repository yet: empty answers, not errors.
		expect(
			await provider.context({ task: "Fix the flaky checkout test.", max_tokens: 2000, format: "markdown" }),
		).toEqual({
			context: "",
			tokens: 0,
		});
		expect(await provider.recall({ query: "checkout", limit: 8 })).toEqual([]);
		// The first write creates the space.
		expect(
			await provider.remember({
				type: "procedure",
				text: "Checkout tests need STRIPE_FAKE=1.",
				refs: [{ app: "fingers", type: "session", id: "s1" }],
			}),
		).toEqual({ id: "lt_1", merged_into: null });
		expect(await provider.context({ task: "Fix it", max_tokens: 2000, format: "markdown" })).toEqual({
			context: "- Checkout tests need STRIPE_FAKE=1.",
			tokens: 12,
		});
		expect(await provider.recall({ query: "checkout" })).toEqual([
			{ ref: "lt_1 v1", kind: "fact", text: "Checkout tests need STRIPE_FAKE=1.", score: 0.9 },
		]);
		expect(
			await provider.reportEvents([
				{
					id: "s1:e1:outcome",
					kind: "outcome",
					at: "2026-11-26T10:00:00Z",
					text: "Task: x",
					outcome: { status: "succeeded" },
				},
			]),
		).toEqual({ accepted: 1, duplicates: 0 });

		expect(mock.requests.map((request) => request.op)).toEqual([
			"context",
			"recall",
			"memories",
			"context",
			"recall",
			"events",
		]);
		for (const request of mock.requests) {
			expect(request.space).toBe(`subject:project:${REPO}`);
			expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
			expect(request.headers["content-type"]).toBe("application/json");
			expect(request.headers["x-request-id"]).toMatch(/^req_[0-9a-f]{32}$/);
			expect(request.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
			expect(request.headers["veyra-organization"]).toBeUndefined();
		}
		expect(new Set(mock.requests.map((request) => request.headers["x-request-id"])).size).toBe(6);
		expect(repositorySpace(REPO)).toBe("subject:project:github.com/acme/web");
	});

	it("turns Brain's refusals, an unreachable Brain and a missing token into memory errors", async () => {
		const refused = await brain({ failWith: problem(403, "permission_denied", "Permission denied") });
		const provider = new BrainMemoryProvider({ api: refused.api, org: ORG, repository: REPO, scope: "web" });
		await expect(provider.context({ task: "t", max_tokens: 100 })).rejects.toMatchObject({
			name: "MemoryUnavailableError",
			code: "permission_denied",
			status: 403,
		});
		const capped = await brain({ failWith: problem(402, "spend_limit_reached", "Spend limit") });
		await expect(
			new BrainMemoryProvider({ api: capped.api, org: ORG, repository: REPO, scope: "web" }).recall({ query: "q" }),
		).rejects.toMatchObject({ code: "spend_limit_reached" });
		const down = new BrainMemoryProvider({
			api: { app: "brain", baseUrl: "http://127.0.0.1:9/brain/v1", org: ORG, accessToken: async () => TOKEN },
			org: ORG,
			repository: REPO,
			scope: "web",
		});
		await expect(down.recall({ query: "q" })).rejects.toMatchObject({
			name: "MemoryUnavailableError",
			code: "unreachable",
		});
		const noToken = new BrainMemoryProvider({
			api: {
				app: "brain",
				baseUrl: refused.api.baseUrl,
				org: ORG,
				accessToken: async () => {
					throw new Error("Connect gives Fingers no brain token");
				},
			},
			org: ORG,
			repository: REPO,
			scope: "web",
		});
		await expect(noToken.remember({ type: "fact", text: "x" })).rejects.toMatchObject({ code: "no_token" });
		const garbled = new BrainMemoryProvider({
			api: refused.api,
			org: ORG,
			repository: REPO,
			scope: "web",
			fetch: async () => new Response("<html>gateway</html>", { status: 200 }),
		});
		await expect(garbled.context({ task: "t", max_tokens: 100 })).rejects.toMatchObject({ code: "invalid_response" });
		// No request without the token.
		expect(refused.requests.every((request) => request.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
	});
});

const MEDIUM: EeEntitlement = {
	signedIn: true,
	source: "connect",
	org: "org_acme",
	orgName: "Acme",
	tier: "medium",
	fingersEnabled: true,
};

describe("Brain memory through the gate", () => {
	afterEach(() => ee.brainMemory.reset());

	async function gateWith(entitlement: EeEntitlement, api: EeVeyraApi | undefined, repository: string | undefined) {
		const providers = new MemoryProviders({ lookupRepository: async () => repository });
		const gate = new EditionGate({ loadModule: async () => ee, memory: providers, veyraApi: () => api });
		await gate.setEntitlement(entitlement);
		return { gate, providers };
	}

	it("gives the Brain provider for the repository when the tier includes Brain", async () => {
		const mock = await brain();
		const { gate, providers } = await gateWith(MEDIUM, mock.api, REPO);
		const provider = await providers.providerFor("/work/web");
		expect(provider).toBeInstanceOf(BrainMemoryProvider);
		expect(provider).toMatchObject({ name: "Brain", scope: "web", repository: REPO });
		expect(gate.commandHandler("memory")).toBeTypeOf("function");
		// Off the moment the feature goes off.
		await gate.setEntitlement({ ...MEDIUM, tier: "low" });
		expect(await providers.providerFor("/work/web")).toBeUndefined();
		expect(gate.commandHandler("memory")).toBeUndefined();
	});

	it("is a quiet no-op without the tier, the sign-in, the Fingers app, the API or a repository", async () => {
		const mock = await brain();
		const cases: Array<[EeEntitlement, EeVeyraApi | undefined, string | undefined]> = [
			[{ ...MEDIUM, tier: "low" }, mock.api, REPO],
			[{ ...MEDIUM, tier: "free" }, mock.api, REPO],
			[{ signedIn: false, source: "none", fingersEnabled: false }, mock.api, REPO],
			[{ ...MEDIUM, fingersEnabled: false }, mock.api, REPO],
			[MEDIUM, undefined, REPO],
			[MEDIUM, mock.api, undefined],
		];
		for (const [entitlement, api, repository] of cases) {
			const { providers } = await gateWith(entitlement, api, repository);
			expect(await providers.providerFor("/work/web"), JSON.stringify(entitlement)).toBeUndefined();
		}
		expect(mock.requests).toEqual([]);
	});

	it("keys a provider by organization and repository, and makes none without an organization", async () => {
		const mock = await brain();
		let org: string | undefined = ORG;
		const api: EeVeyraApi = {
			app: "brain",
			baseUrl: mock.api.baseUrl,
			get org() {
				return org;
			},
			accessToken: async () => TOKEN,
		};
		const { providers } = await gateWith(MEDIUM, api, REPO);
		const first = await providers.providerFor("/work/web");
		expect(first?.key).toBe(`${ORG}:${REPO}`);
		org = "org_beta";
		const second = await providers.providerFor("/work/web");
		expect(second).not.toBe(first);
		expect(second?.key).toBe(`org_beta:${REPO}`);
		// The first organization's provider refuses once the sign-in moved on: no request with the new org's token.
		await expect(first!.recall({ query: "checkout" })).rejects.toMatchObject({
			name: "MemoryUnavailableError",
			code: "org_changed",
		});
		expect(mock.requests).toEqual([]);
		org = undefined;
		expect(await providers.providerFor("/work/web")).toBeUndefined();
		expect(() => new BrainMemoryProvider({ api, org: "", repository: REPO, scope: "web" })).toThrow(
			/signed-in organization/,
		);
	});

	it("refuses when the organization changes while the token is fetched (no request with the other org's token)", async () => {
		const mock = await brain();
		let org: string | undefined = ORG;
		const api: EeVeyraApi = {
			app: "brain",
			baseUrl: mock.api.baseUrl,
			get org() {
				return org;
			},
			// `/org switch` finishes while the token is on its way: the token that comes back is the new org's.
			accessToken: async () => {
				org = "org_beta";
				return "token-of-org-beta";
			},
		};
		const provider = new BrainMemoryProvider({ api, org: ORG, repository: REPO, scope: "web" });
		await expect(provider.remember({ type: "fact", text: "ORG_A_ONLY copied", refs: [] })).rejects.toMatchObject({
			name: "MemoryUnavailableError",
			code: "org_changed",
		});
		expect(mock.requests).toEqual([]);
	});

	it("hands ee a Brain API only while signed in, and no other app's", async () => {
		const asked: string[] = [];
		const providers = new MemoryProviders({ lookupRepository: async () => REPO });
		const gate = new EditionGate({
			loadModule: async () => ({
				...ee,
				activate: (host) => {
					asked.push(String(host.veyraApi("brain")?.baseUrl));
					asked.push(String(host.veyraApi("connect" as never)));
					ee.activate(host);
				},
			}),
			memory: providers,
			veyraApi: (app) => ({
				app,
				baseUrl: `https://api.veyra.so/${app}/v1`,
				org: ORG,
				accessToken: async () => TOKEN,
			}),
		});
		await gate.setEntitlement(MEDIUM);
		await gate.setEntitlement({ signedIn: false, source: "none", fingersEnabled: false });
		expect(asked).toEqual(["https://api.veyra.so/brain/v1", "undefined", "undefined", "undefined"]);
	});
});

describe("a session with Brain memory", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		ee.brainMemory.reset();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("starts the task with what Brain remembers, offers the tools and reports the outcome", async () => {
		const mock = await brain();
		mock.spaces.set(`subject:project:${REPO}`, ["Checkout tests need STRIPE_FAKE=1."]);
		const providers = new MemoryProviders({ lookupRepository: async () => REPO });
		const gate = new EditionGate({ loadModule: async () => ee, memory: providers, veyraApi: () => mock.api });
		await gate.setEntitlement(MEDIUM);
		const harness = await createHarness({
			extensionFactories: [{ name: "memory", factory: createBuiltinMemoryExtension(providers) }],
		});
		harnesses.push(harness);
		let system = "";
		let tools: string[] = [];
		harness.setResponses([
			(context: { messages: Message[] }) => {
				system = JSON.stringify(context.messages.filter((message) => message.role === "system"));
				tools = getCurrentTools(context.messages).map((tool) => tool.name);
				return fauxAssistantMessage("Set STRIPE_FAKE=1.");
			},
		]);
		await harness.session.prompt("Fix the flaky checkout test.");
		expect(system).toContain("What Brain remembers for this repository");
		expect(system).toContain("- Checkout tests need STRIPE_FAKE=1.");
		expect(tools).toEqual(expect.arrayContaining(["memory_recall", "memory_remember"]));
		expect(mock.requests.map((request) => request.op)).toEqual(["context", "events"]);
		expect(mock.requests[0]!.body).toMatchObject({ task: "Fix the flaky checkout test.", max_tokens: 2000 });
		expect(mock.requests[1]!.body).toMatchObject({
			events: [{ kind: "outcome", outcome: { status: "succeeded" }, ref: { app: "fingers", type: "session" } }],
		});
	});

	it("never carries one organization's Brain memory into a run for another (`/org switch`)", async () => {
		const orgA = await brain();
		orgA.spaces.set(`subject:project:${REPO}`, ["ORG_A_ONLY: checkout tests need STRIPE_FAKE=1."]);
		const orgB = await brain();
		orgB.spaces.set(`subject:project:${REPO}`, ["ORG_B: deploys go through the release train."]);
		// The core's live sign-in: `/org switch` replaces the organization and its tokens in place.
		let signedIn = { org: ORG, mock: orgA };
		const api: EeVeyraApi = {
			app: "brain",
			get baseUrl() {
				return signedIn.mock.api.baseUrl;
			},
			get org() {
				return signedIn.org;
			},
			accessToken: async () => TOKEN,
		};
		const providers = new MemoryProviders({ lookupRepository: async () => REPO });
		const gate = new EditionGate({ loadModule: async () => ee, memory: providers, veyraApi: () => api });
		await gate.setEntitlement(MEDIUM);
		const harness = await createHarness({
			extensionFactories: [{ name: "memory", factory: createBuiltinMemoryExtension(providers) }],
		});
		harnesses.push(harness);
		const systems: string[] = [];
		const answer = (text: string) => (context: { messages: Message[] }) => {
			systems.push(JSON.stringify(context.messages.filter((message) => message.role === "system")));
			return fauxAssistantMessage(text);
		};
		harness.setResponses([answer("ok")]);
		await harness.session.prompt("Fix the flaky checkout test.");
		expect(systems[0]).toContain("ORG_A_ONLY");

		signedIn = { org: "org_beta", mock: orgB };
		await gate.setEntitlement({ ...MEDIUM, org: "org_beta", orgName: "Beta" });
		harness.setResponses([answer("ok")]);
		await harness.session.prompt("Go on.");
		expect(systems[1]).not.toContain("ORG_A_ONLY");
		expect(systems[1]).toContain("ORG_B: deploys go through the release train.");
		expect(orgB.requests.map((request) => request.op)).toEqual(["context", "events"]);
		// Org A got only its own run: nothing of org B's run reached it.
		expect(orgA.requests.map((request) => request.op)).toEqual(["context", "events"]);
		expect(JSON.stringify(orgB.requests.map((request) => request.body))).not.toContain("ORG_A_ONLY");
	});

	it("changes nothing on a tier without Brain", async () => {
		const mock = await brain();
		const providers = new MemoryProviders({ lookupRepository: async () => REPO });
		const gate = new EditionGate({ loadModule: async () => ee, memory: providers, veyraApi: () => mock.api });
		await gate.setEntitlement({ ...MEDIUM, tier: "low" });
		const harness = await createHarness({
			extensionFactories: [{ name: "memory", factory: createBuiltinMemoryExtension(providers) }],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("Fix the flaky checkout test.");
		expect(mock.requests).toEqual([]);
	});
});

describe("/memory", () => {
	afterEach(() => ee.brainMemory.reset());

	async function run(args: string, repository: string | undefined, api: EeVeyraApi) {
		const providers = new MemoryProviders({ lookupRepository: async () => repository });
		const gate = new EditionGate({ loadModule: async () => ee, memory: providers, veyraApi: () => api });
		await gate.setEntitlement(MEDIUM);
		const lines: string[] = [];
		const context: EeCommandContext = {
			args,
			cwd: "/work/web",
			repository,
			entitlement: MEDIUM,
			showStatus: (message) => lines.push(`status: ${message}`),
			showWarning: (message) => lines.push(`warning: ${message}`),
		};
		await gate.commandHandler("memory")!(context);
		return { lines, providers };
	}

	it("shows the status, recalls, remembers, and turns memory off and on for the repository", async () => {
		const mock = await brain();
		expect((await run("", REPO, mock.api)).lines).toEqual([
			"status: Brain memory is on for “web” (github.com/acme/web): each task starts with what Brain remembers for it, the model can recall and remember, and Brain learns from how tasks end. /memory off turns it off for this session.",
		]);
		expect((await run("remember Checkout tests need STRIPE_FAKE=1.", REPO, mock.api)).lines).toEqual([
			"status: Saved to Brain for “web” (lt_1).",
		]);
		expect((await run("recall checkout", REPO, mock.api)).lines).toEqual([
			"status: Brain, “web”: 1 item\n  fact · Checkout tests need STRIPE_FAKE=1.",
		]);
		const off = await run("off", REPO, mock.api);
		expect(off.lines).toEqual(["status: Brain memory is off for “web” until you run /memory on or restart Fingers."]);
		expect(await off.providers.providerFor("/work/web")).toBeUndefined();
		expect((await run("recall checkout", REPO, mock.api)).lines).toEqual([
			"warning: Brain memory is off for “web”. /memory on turns it back on.",
		]);
		const on = await run("on", REPO, mock.api);
		expect(on.lines).toEqual(["status: Brain memory is on for “web”."]);
		expect(await on.providers.providerFor("/work/web")).toBeInstanceOf(BrainMemoryProvider);
	});

	it("explains a directory without a repository, bad arguments and an unavailable Brain", async () => {
		const mock = await brain();
		expect((await run("", undefined, mock.api)).lines[0]).toMatch(/^warning: Brain memory needs a git repository/);
		expect((await run("recall", REPO, mock.api)).lines[0]).toMatch(/^warning: Usage: \/memory/);
		expect((await run("forget everything", REPO, mock.api)).lines[0]).toMatch(/^warning: Usage: \/memory/);
		const down = { ...mock.api, baseUrl: "http://127.0.0.1:9/brain/v1" };
		expect((await run("recall x", REPO, down)).lines[0]).toMatch(
			/^warning: Brain memory is unavailable: Brain is not reachable/,
		);
	});
});
