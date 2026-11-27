// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * Eyes telemetry: the feature through the real gate and core (on only with a tier that includes Eyes and a
 * sign-in; otherwise nothing is sent), a whole session whose trace reaches a mock of Eyes' OTLP/HTTP door
 * (`/eyes/otlp/v1/traces`, platform contracts/v1/eyes-feed.md: an ordinary OTLP source with the person's token,
 * `service.name = fingers`, no `veyra.app`, only registry `veyra.*` names, no payloads), organization isolation, the
 * console link and `/eyes`.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { EeCommandContext, EeEntitlement, EeHost, EeVeyraApi, SpanExporter } from "@veyraco/fingers";
import { fauxAssistantMessage, fauxToolCall } from "@veyraco/fingers-ai";
import { afterEach, describe, expect, it } from "vitest";
import { EditionGate } from "../../packages/coding-agent/src/core/edition/gate.ts";
import { createTelemetryExtension } from "../../packages/coding-agent/src/core/tracing/extension.ts";
import { TelemetryExporters } from "../../packages/coding-agent/src/core/tracing/registry.ts";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.ts";
import { EyesTelemetry, eyesTraceLink, eyesTracesUrl } from "../src/eyes/index.ts";
import * as ee from "../src/index.ts";

/** The `veyra.*` attribute registry of contracts/v1/eyes-feed.md: Eyes drops any other `veyra.*` name. */
const REGISTRY = new Set([
	"veyra.org_id",
	"veyra.app",
	"veyra.actor",
	"veyra.agent_id",
	"veyra.run_id",
	"veyra.task_id",
	"veyra.task_ref",
	"veyra.session_id",
	"veyra.correlation_id",
	"veyra.model_connection",
	"veyra.turn_id",
	"veyra.sandbox_id",
	"veyra.prp.event_type",
	"veyra.approval.id",
	"veyra.approval.outcome",
	"veyra.retry.attempt",
	"veyra.retry.reason",
	"veyra.compaction.tokens_before",
	"veyra.compaction.tokens_after",
	"veyra.tokens_saved",
	"veyra.task.status",
	"veyra.task.previous_status",
	"veyra.budget.scope",
	"veyra.memory.operation",
	"veyra.memory.ids",
	"veyra.memory.count",
	"veyra.memory.query",
	"veyra.memory.items",
	"veyra.workspace.files_changed",
	"veyra.workspace.diff",
]);
const PAYLOAD = [
	"gen_ai.input.messages",
	"gen_ai.output.messages",
	"gen_ai.system_instructions",
	"gen_ai.tool.call.arguments",
	"gen_ai.tool.call.result",
];

const servers: Server[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
	ee.eyesTelemetry.reset();
	await ee.eyesTelemetry.command({
		args: "on",
		cwd: "/",
		entitlement: MEDIUM,
		showStatus: () => {},
		showWarning: () => {},
	});
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Received {
	path: string;
	authorization: string | undefined;
	body: any;
}

async function eyes(): Promise<{ url: string; received: Received[] }> {
	const received: Received[] = [];
	const server = createServer((request: IncomingMessage, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			received.push({
				path: request.url ?? "",
				authorization: request.headers.authorization,
				body: JSON.parse(body),
			});
			response.setHeader("content-type", "application/json");
			response.end("{}");
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

const MEDIUM: EeEntitlement = {
	signedIn: true,
	source: "connect",
	org: "org_acme",
	orgName: "Acme",
	tier: "medium",
	fingersEnabled: true,
};

function signedInApi(url: string, signedIn: { org: string | undefined; code?: string }): EeVeyraApi {
	return {
		app: "eyes",
		baseUrl: `${url}/eyes/v1`,
		get org() {
			return signedIn.org;
		},
		get orgCode() {
			return signedIn.code;
		},
		accessToken: async () => `token-for-${signedIn.org}`,
	};
}

/** `api` is one shared object, or a factory that, like interactive mode's `veyraApi`, builds a new one per call. */
async function setup(entitlement: EeEntitlement, api: EeVeyraApi | undefined | (() => EeVeyraApi | undefined)) {
	const exporters = new TelemetryExporters();
	const veyraApi = typeof api === "function" ? api : () => api;
	const gate = new EditionGate({ loadModule: async () => ee, telemetry: exporters, veyraApi });
	await gate.setEntitlement(entitlement);
	const harness = await createHarness({
		extensionFactories: [
			{
				name: "telemetry",
				factory: createTelemetryExtension({ exporters: () => exporters.active(), flush: () => exporters.flush() }),
			},
		],
	});
	harnesses.push(harness);
	return { gate, exporters, harness };
}

function spansOf(received: Received[]): any[] {
	return received.flatMap((request) => request.body.resourceSpans[0].scopeSpans[0].spans);
}

function attributesOf(span: any): Record<string, unknown> {
	return Object.fromEntries(span.attributes.map((kv: any) => [kv.key, kv.value]));
}

function context(args: string, statuses: string[], warnings: string[] = []): EeCommandContext {
	return {
		args,
		cwd: "/work/web",
		entitlement: MEDIUM,
		showStatus: (message) => statuses.push(message),
		showWarning: (message) => warnings.push(message),
	};
}

describe("Eyes telemetry through the gate", () => {
	it("sends each run's trace to Eyes' OTLP door with the person's token, metadata only", async () => {
		const mock = await eyes();
		const signedIn = { org: "org_acme" as string | undefined, code: "acme" };
		const { gate, exporters, harness } = await setup(MEDIUM, signedInApi(mock.url, signedIn));
		expect(gate.commandHandler("eyes")).toBeTypeOf("function");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("ls", {}, { id: "call_ls" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("The secret plan is in notes.md."),
		]);
		await harness.session.prompt("Where is the secret plan?");
		await exporters.flush();

		expect(mock.received.length).toBeGreaterThan(0);
		for (const request of mock.received) {
			expect(request.path).toBe("/eyes/otlp/v1/traces");
			expect(request.authorization).toBe("Bearer token-for-org_acme");
			const resource = Object.fromEntries(
				request.body.resourceSpans[0].resource.attributes.map((kv: any) => [kv.key, kv.value]),
			);
			expect(resource["service.name"]).toEqual({ stringValue: "fingers" });
			expect(resource).not.toHaveProperty("veyra.app");
		}
		const spans = spansOf(mock.received);
		expect(spans.map((span) => span.name)).toEqual([
			"chat faux-1",
			"execute_tool ls",
			"chat faux-1",
			"invoke_agent fingers",
		]);
		for (const span of spans) {
			const attributes = attributesOf(span);
			// A person's token is no feed: no veyra.app, and only names Eyes' registry knows.
			expect(attributes).not.toHaveProperty("veyra.app");
			for (const name of Object.keys(attributes)) {
				if (name.startsWith("veyra.")) expect(REGISTRY.has(name), name).toBe(true);
				expect(PAYLOAD).not.toContain(name);
			}
		}
		expect(JSON.stringify(mock.received)).not.toContain("secret plan");

		// The console link of the run's trace.
		const statuses: string[] = [];
		await gate.commandHandler("eyes")!(context("", statuses));
		expect(statuses[0]).toContain("Eyes telemetry is on for Acme");
		// The mock's API origin is not `api.<domain>`: no console link to show.
		expect(statuses[0]).not.toContain("Last trace");
		const run = spans.find((span) => span.name === "invoke_agent fingers");
		expect(ee.eyesTelemetry.lastTraceLink()).toBeUndefined();
		expect(eyesTraceLink("https://api.veyra.so/eyes/v1", "Acme", run.traceId)).toBe(
			`https://eyes.veyra.so/acme/traces/${run.traceId}`,
		);
	});

	it("sends nothing without the tier, the sign-in, the Fingers app or the API", async () => {
		const mock = await eyes();
		const api = signedInApi(mock.url, { org: "org_acme" });
		const cases: Array<[EeEntitlement, EeVeyraApi | undefined]> = [
			[{ ...MEDIUM, tier: "low" }, api],
			[{ ...MEDIUM, tier: "free" }, api],
			[{ signedIn: false, source: "none", fingersEnabled: false }, api],
			[{ ...MEDIUM, fingersEnabled: false }, api],
			[MEDIUM, undefined],
		];
		for (const [entitlement, caseApi] of cases) {
			const { exporters, harness } = await setup(entitlement, caseApi);
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("hi");
			await exporters.flush();
		}
		expect(mock.received).toEqual([]);
	});

	it("never sends one organization's spans with another's token", async () => {
		const mock = await eyes();
		const signedIn = { org: "org_acme" as string | undefined };
		let switchDuringToken = false;
		const api: EeVeyraApi = {
			...signedInApi(mock.url, signedIn),
			get org() {
				return signedIn.org;
			},
			accessToken: async () => {
				const token = `token-for-${signedIn.org}`;
				// `/org switch` finishes while the token is on its way.
				if (switchDuringToken) signedIn.org = "org_beta";
				return token;
			},
		};
		const { exporters, harness } = await setup(MEDIUM, api);
		const span = {
			trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
			span_id: "a1b2c3d4e5f60718",
			name: "chat m",
			kind: "client" as const,
			start_time_unix_nano: "1",
			end_time_unix_nano: "2",
			attributes: {},
			status: { code: "ok" as const },
		};
		// Spans queued for org_acme, then a switch before they go out: dropped, not sent with org_beta's token.
		ee.eyesTelemetry.exporter.export(span);
		signedIn.org = "org_beta";
		await exporters.flush();
		expect(mock.received).toEqual([]);

		// The switch lands while the token is fetched: that token is the new organization's, nothing goes out.
		signedIn.org = "org_acme";
		ee.eyesTelemetry.exporter.export(span);
		switchDuringToken = true;
		await exporters.flush();
		switchDuringToken = false;
		expect(mock.received).toEqual([]);

		// A run under org_beta goes to org_beta.
		harness.setResponses([fauxAssistantMessage("for beta")]);
		await harness.session.prompt("beta work");
		await exporters.flush();
		expect(mock.received.map((request) => request.authorization)).toEqual(["Bearer token-for-org_beta"]);
		expect(spansOf(mock.received).map((sent) => sent.name)).toEqual(["chat faux-1", "invoke_agent fingers"]);
	});

	it("keeps sending after a re-activation that hands it a new API object (hourly re-check)", async () => {
		const mock = await eyes();
		const signedIn = { org: "org_acme" as string | undefined, code: "acme" };
		// Interactive mode builds a new EeVeyraApi on every call, and every activation calls it.
		const { gate, exporters, harness } = await setup(MEDIUM, () => signedInApi(mock.url, signedIn));
		harness.setResponses([fauxAssistantMessage("first")]);
		await harness.session.prompt("one");
		await exporters.flush();
		// The hourly entitlement re-check activates the ee module again.
		await gate.setEntitlement(MEDIUM);
		harness.setResponses([fauxAssistantMessage("second")]);
		await harness.session.prompt("two");
		await exporters.flush();
		expect(mock.received).toHaveLength(2);
		expect(mock.received.map((request) => request.authorization)).toEqual([
			"Bearer token-for-org_acme",
			"Bearer token-for-org_acme",
		]);
		expect(spansOf(mock.received).filter((span) => span.name === "invoke_agent fingers")).toHaveLength(2);
	});

	it("sends each organization's runs with its own token across A, B and back to A", async () => {
		const mock = await eyes();
		const signedIn = { org: "org_acme" as string | undefined };
		const { gate, exporters, harness } = await setup(MEDIUM, () => signedInApi(mock.url, signedIn));
		const switchTo = async (org: string) => {
			signedIn.org = org;
			// `/org switch` signs in again: the gate activates the ee module with the new organization.
			await gate.setEntitlement({ ...MEDIUM, org });
		};
		harness.setResponses([fauxAssistantMessage("acme 1")]);
		await harness.session.prompt("acme 1");
		await exporters.flush();

		// An org_acme span still queued when the sign-in moves to org_beta is dropped, never sent with beta's token.
		ee.eyesTelemetry.exporter.export({
			trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
			span_id: "a1b2c3d4e5f60718",
			name: "chat queued",
			kind: "client",
			start_time_unix_nano: "1",
			end_time_unix_nano: "2",
			attributes: {},
			status: { code: "ok" },
		});
		await switchTo("org_beta");
		harness.setResponses([fauxAssistantMessage("beta")]);
		await harness.session.prompt("beta");
		await exporters.flush();

		await switchTo("org_acme");
		harness.setResponses([fauxAssistantMessage("acme 2")]);
		await harness.session.prompt("acme 2");
		await exporters.flush();

		expect(mock.received.map((request) => request.authorization)).toEqual([
			"Bearer token-for-org_acme",
			"Bearer token-for-org_beta",
			"Bearer token-for-org_acme",
		]);
		expect(spansOf(mock.received).map((span) => span.name)).not.toContain("chat queued");
	});

	it("stops and resumes with /eyes off and /eyes on", async () => {
		const mock = await eyes();
		const { gate, exporters, harness } = await setup(MEDIUM, signedInApi(mock.url, { org: "org_acme" }));
		const statuses: string[] = [];
		const warnings: string[] = [];
		const eyesCommand = gate.commandHandler("eyes")!;
		await eyesCommand(context("off", statuses));
		harness.setResponses([fauxAssistantMessage("quiet")]);
		await harness.session.prompt("hi");
		await exporters.flush();
		expect(mock.received).toEqual([]);
		await eyesCommand(context("", statuses));
		expect(statuses.at(-1)).toContain("off in this session");
		await eyesCommand(context("on", statuses));
		harness.setResponses([fauxAssistantMessage("loud")]);
		await harness.session.prompt("hi");
		await exporters.flush();
		expect(mock.received).toHaveLength(1);
		await eyesCommand(context("open", statuses, warnings));
		expect(warnings.at(-1)).toContain("console link is not known");
		await eyesCommand(context("bogus", statuses, warnings));
		expect(warnings.at(-1)).toContain("Usage: /eyes");
	});
});

describe("Eyes addresses", () => {
	it("pairs the API origin with Eyes' OTLP door and console", () => {
		expect(eyesTracesUrl("https://api.veyra.so/eyes/v1")).toBe("https://api.veyra.so/eyes/otlp/v1/traces");
		expect(eyesTracesUrl("https://api.veyra.localhost/eyes/v1/")).toBe(
			"https://api.veyra.localhost/eyes/otlp/v1/traces",
		);
		expect(eyesTraceLink("https://api.veyra.localhost/eyes/v1", "acme", "4bf9")).toBe(
			"https://eyes.veyra.localhost/acme/traces/4bf9",
		);
		expect(eyesTraceLink("https://api.veyra.so/eyes/v1", undefined, "4bf9")).toBeUndefined();
		expect(eyesTraceLink("http://127.0.0.1:9/eyes/v1", "acme", "4bf9")).toBeUndefined();
	});
});

describe("Eyes link for the savings report", () => {
	it("hands the core the console link of the last run's trace through the exporter", () => {
		const telemetry = new EyesTelemetry();
		const sent: unknown[] = [];
		const api: EeVeyraApi = {
			app: "eyes",
			baseUrl: "https://api.veyra.so/eyes/v1",
			org: "org_acme",
			orgCode: "acme",
			accessToken: async () => "token",
		};
		telemetry.attach({
			veyraApi: () => api,
			createOtlpExporter: () => ({ export: (span: unknown) => sent.push(span), flush: async () => {} }),
			registerTelemetryExporter: () => {},
			registerCommand: () => {},
		} as unknown as EeHost);
		expect(telemetry.exporter.lastTraceLink?.()).toBeUndefined();
		telemetry.exporter.export({
			trace_id: "0af7651916cd43dd8448eb211c80319c",
			span_id: "b7ad6b7169203331",
			name: "invoke_agent fingers",
			kind: "internal",
			start_time_unix_nano: "1",
			end_time_unix_nano: "2",
			status: { code: "ok" },
			attributes: {},
		} as unknown as Parameters<SpanExporter["export"]>[0]);
		expect(sent).toHaveLength(1);
		expect(telemetry.exporter.lastTraceLink?.()).toBe(
			"https://eyes.veyra.so/acme/traces/0af7651916cd43dd8448eb211c80319c",
		);
	});
});
