/**
 * The ee gate (open core): an ee feature is on only when the ee module is there, the person is signed in, Connect
 * confirmed the organization within 72 hours and did not refuse it, the organization has Fingers on and its tier
 * includes the feature. Connect's answer is kept with the sign-in in the keychain and counts offline for 72 hours.
 * The ee module is found at run time; these tests use stand-in modules, so they pass without the ee/ folder.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cachedEntitlement,
	EditionGate,
	EE_OFFLINE_GRACE_MS,
	type EeEntitlement,
	type EeFeatureId,
	type EeModule,
	type EntitlementSource,
	eeFeatureState,
	eeModuleCandidates,
	loadEeModule,
	resolveEntitlement,
	SIGNED_OUT,
	type VeyraTier,
} from "../src/core/edition/index.ts";
import { MemoryProviders } from "../src/core/memory/registry.ts";
import { InMemorySecretStore } from "../src/core/os-keychain.ts";
import { SubagentEngines } from "../src/core/subagents/registry.ts";
import type { SubagentEngine } from "../src/core/subagents/types.ts";
import { OtlpHttpExporter } from "../src/core/tracing/otlp.ts";
import { TelemetryExporters } from "../src/core/tracing/registry.ts";
import { ConnectUnavailableError, VeyraApiError } from "../src/core/veyra/oidc-client.ts";
import { openVeyraSessionVault, type VeyraAccount } from "../src/core/veyra/session-vault.ts";
import { VeyraAuth, type VeyraOrganization, VeyraSignedOutError } from "../src/core/veyra/veyra-auth.ts";
import { FAKE_ORG, FakeConnect } from "./veyra-fake-connect.ts";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

/** A stand-in ee module with a tier matrix like ee/'s. */
function fakeModule(overrides: Partial<EeModule> = {}): EeModule {
	const matrix: Record<EeFeatureId, VeyraTier> = {
		token_saving: "low",
		subagents: "medium",
		checkpoints: "medium",
		brain: "medium",
		eyes: "medium",
		org_hooks: "high",
	};
	return {
		apiVersion: 7,
		matrixVersion: "test.1",
		minimumTier: (feature) => matrix[feature],
		activate: (host) => {
			if (host.isOn("subagents")) host.registerCommand("agents", (context) => context.showStatus("agents ran"));
		},
		...overrides,
	};
}

const SIGNED_IN: EeEntitlement = {
	signedIn: true,
	source: "connect",
	org: "org_1",
	orgName: "Acme",
	tier: "medium",
	fingersEnabled: true,
	checkedAt: NOW,
};

describe("eeFeatureState", () => {
	const module = fakeModule();

	it("is on for a signed-in organization with Fingers on and a tier that includes the feature", () => {
		expect(eeFeatureState("subagents", SIGNED_IN, module)).toEqual({ on: true });
		expect(eeFeatureState("token_saving", { ...SIGNED_IN, tier: "low" }, module)).toEqual({ on: true });
		expect(eeFeatureState("org_hooks", { ...SIGNED_IN, tier: "high" }, module)).toEqual({ on: true });
	});

	it("names the first reason that fails, most fundamental first", () => {
		expect(eeFeatureState("subagents", SIGNED_IN, undefined)).toEqual({ on: false, reason: "no_ee" });
		expect(eeFeatureState("subagents", SIGNED_OUT, undefined)).toEqual({ on: false, reason: "no_ee" });
		expect(eeFeatureState("subagents", SIGNED_OUT, module)).toEqual({ on: false, reason: "signed_out" });
		expect(eeFeatureState("subagents", { ...SIGNED_IN, denied: "403", source: "none" }, module)).toEqual({
			on: false,
			reason: "denied",
		});
		expect(eeFeatureState("subagents", { ...SIGNED_IN, source: "none", offline: true }, module)).toEqual({
			on: false,
			reason: "offline",
		});
		expect(eeFeatureState("subagents", { ...SIGNED_IN, fingersEnabled: false }, module)).toEqual({
			on: false,
			reason: "fingers_off",
		});
		expect(eeFeatureState("subagents", { ...SIGNED_IN, tier: "enterprise" }, module)).toEqual({
			on: false,
			reason: "unknown_tier",
		});
		expect(eeFeatureState("subagents", { ...SIGNED_IN, tier: undefined }, module)).toEqual({
			on: false,
			reason: "unknown_tier",
		});
		expect(eeFeatureState("subagents", { ...SIGNED_IN, tier: "low" }, module)).toEqual({
			on: false,
			reason: "tier",
			needs: "medium",
		});
	});

	it("keeps every feature off on Free and a feature no tier includes off everywhere", () => {
		for (const feature of ["token_saving", "subagents", "org_hooks"] as const) {
			expect(eeFeatureState(feature, { ...SIGNED_IN, tier: "free" }, module).on).toBe(false);
		}
		const none = fakeModule({ minimumTier: () => undefined });
		expect(eeFeatureState("subagents", { ...SIGNED_IN, tier: "high" }, none)).toEqual({ on: false, reason: "tier" });
		const throwing = fakeModule({
			minimumTier: () => {
				throw new Error("broken matrix");
			},
		});
		expect(eeFeatureState("subagents", { ...SIGNED_IN, tier: "high" }, throwing).on).toBe(false);
	});

	it("counts cached facts within the grace period, not facts that are too old", () => {
		expect(eeFeatureState("subagents", { ...SIGNED_IN, source: "cache" }, module)).toEqual({ on: true });
	});
});

function account(overrides: Partial<VeyraAccount> = {}): VeyraAccount {
	return {
		issuer: "https://connect.veyra.localhost",
		subject: "usr_ada",
		email: "ada@example.com",
		org: "org_1",
		orgName: "Acme",
		tier: "medium",
		fingersEnabled: true,
		entitlementCheckedAt: NOW - HOUR,
		signedInAt: NOW - 2 * HOUR,
		storage: { persistent: true, location: "macOS Keychain" },
		...overrides,
	};
}

describe("cachedEntitlement (72 h offline)", () => {
	it("uses the kept facts up to 72 hours after Connect gave them", () => {
		expect(cachedEntitlement(account({ entitlementCheckedAt: NOW - EE_OFFLINE_GRACE_MS }), NOW)).toMatchObject({
			signedIn: true,
			source: "cache",
			tier: "medium",
			fingersEnabled: true,
		});
	});

	it("turns ee off one millisecond after the 72 hours", () => {
		const entitlement = cachedEntitlement(account({ entitlementCheckedAt: NOW - EE_OFFLINE_GRACE_MS - 1 }), NOW);
		expect(entitlement).toMatchObject({ signedIn: true, source: "none", offline: true, fingersEnabled: false });
		expect(entitlement.tier).toBeUndefined();
		expect(eeFeatureState("subagents", entitlement, fakeModule())).toEqual({ on: false, reason: "offline" });
	});

	it("does not trust facts never confirmed, or stamped in the future", () => {
		expect(cachedEntitlement(account({ entitlementCheckedAt: undefined }), NOW).source).toBe("none");
		expect(cachedEntitlement(account({ entitlementCheckedAt: NOW + 60 * 60 * 1000 }), NOW).source).toBe("none");
		expect(cachedEntitlement(account({ entitlementCheckedAt: NOW + 60_000 }), NOW).source).toBe("cache");
	});

	it("is signed out without an account", () => {
		expect(cachedEntitlement(undefined, NOW)).toEqual(SIGNED_OUT);
	});
});

function source(options: {
	account?: VeyraAccount;
	org?: VeyraOrganization;
	error?: unknown;
}): EntitlementSource & { forgotten: number } {
	const result = {
		forgotten: 0,
		account: () => options.account,
		organization: async () => {
			if (options.error) throw options.error;
			return options.org!;
		},
		forgetEntitlement: async () => {
			result.forgotten++;
		},
	};
	return result;
}

const ORG: VeyraOrganization = {
	id: "org_1",
	name: "Acme",
	tier: "high",
	appsEnabled: ["connect", "fingers"],
};

describe("resolveEntitlement", () => {
	const now = () => NOW;

	it("takes Connect's answer: tier, and Fingers on when apps_enabled lists it", async () => {
		expect(await resolveEntitlement(source({ account: account(), org: ORG }), { now })).toEqual({
			signedIn: true,
			source: "connect",
			org: "org_1",
			orgName: "Acme",
			tier: "high",
			fingersEnabled: true,
			checkedAt: NOW,
		});
		const off = await resolveEntitlement(source({ account: account(), org: { ...ORG, appsEnabled: ["connect"] } }), {
			now,
		});
		expect(off.fingersEnabled).toBe(false);
	});

	it("is signed out without an account, and when Connect ended the sign-in", async () => {
		expect(await resolveEntitlement(source({}), { now })).toEqual(SIGNED_OUT);
		expect(
			await resolveEntitlement(source({ account: account(), error: new VeyraSignedOutError("session_ended") }), {
				now,
			}),
		).toEqual(SIGNED_OUT);
	});

	for (const [name, error] of [
		["a network error", new TypeError("fetch failed")],
		["a timeout", new DOMException("The operation was aborted due to timeout", "TimeoutError")],
		["a 503", new VeyraApiError(503, "unavailable", "Unavailable")],
		["Connect unavailable", new ConnectUnavailableError("Connect answered 502", 502)],
	] as const) {
		it(`falls back to the kept answer on ${name}`, async () => {
			const s = source({ account: account(), error });
			expect(await resolveEntitlement(s, { now })).toMatchObject({ source: "cache", tier: "medium" });
			expect(s.forgotten).toBe(0);
			const old = source({ account: account({ entitlementCheckedAt: NOW - 73 * HOUR }), error });
			expect(await resolveEntitlement(old, { now })).toMatchObject({ source: "none", offline: true });
		});
	}

	it("keeps control characters from Connect out of what the terminal shows", async () => {
		const entitlement = await resolveEntitlement(
			source({
				account: account(),
				org: { ...ORG, name: "Acme\u001b]52;c;aGk=\u0007 Robotics", tier: "hi\u001bgh" },
			}),
			{ now },
		);
		expect(entitlement.orgName).not.toMatch(/[\u0000-\u001f\u007f]/);
		expect(entitlement.tier).not.toMatch(/[\u0000-\u001f\u007f]/);
		expect(eeFeatureState("subagents", entitlement, fakeModule())).toEqual({ on: false, reason: "unknown_tier" });
		const refused = await resolveEntitlement(
			source({ account: account(), error: new VeyraApiError(403, "denied", "No\u001b[2Jpe") }),
			{ now },
		);
		expect(refused.denied).not.toMatch(/[\u0000-\u001f\u007f]/);
	});

	it("treats a refusal as final: no kept answer, and the kept answer is dropped", async () => {
		const s = source({ account: account(), error: new VeyraApiError(403, "permission_denied", "Forbidden") });
		const entitlement = await resolveEntitlement(s, { now });
		expect(entitlement).toMatchObject({ signedIn: true, source: "none", fingersEnabled: false });
		expect(entitlement.denied).toContain("403");
		expect(s.forgotten).toBe(1);
		expect(eeFeatureState("subagents", entitlement, fakeModule())).toEqual({ on: false, reason: "denied" });
	});
});

describe("EditionGate", () => {
	it("lets the ee module register only the commands of features that are on", async () => {
		const registered: string[] = [];
		const module = fakeModule({
			activate: (host) => {
				// A module that tries to register regardless of the tier.
				host.registerCommand("agents", () => {});
				host.registerCommand("not-an-ee-command", () => {});
				registered.push(host.isOn("subagents") ? "on" : "off");
			},
		});
		const gate = new EditionGate({ loadModule: async () => module });
		await gate.setEntitlement({ ...SIGNED_IN, tier: "low" });
		expect(gate.commandHandler("agents")).toBeUndefined();
		expect(gate.commandHandler("not-an-ee-command")).toBeUndefined();
		expect(gate.onFeatures()).toEqual(["token_saving"]);
		expect(gate.isOn()).toBe(true);

		await gate.setEntitlement(SIGNED_IN);
		expect(gate.commandHandler("agents")).toBeTypeOf("function");
		expect(gate.onFeatures()).toEqual(["token_saving", "subagents", "checkpoints", "brain", "eyes"]);

		await gate.setEntitlement(SIGNED_OUT);
		expect(gate.commandHandler("agents")).toBeUndefined();
		expect(gate.isOn()).toBe(false);
		expect(registered).toEqual(["off", "on", "off"]);
	});

	it("lets the ee module register a memory provider only for a feature that is on (F20)", async () => {
		const providers = new MemoryProviders({ lookupRepository: async () => "github.com/acme/web" });
		const provider = {
			name: "Brain",
			key: "org_acme:github.com/acme/web",
			context: async () => ({ context: "", tokens: 0 }),
			recall: async () => [],
			remember: async () => ({ id: "lt_1" }),
			reportEvents: async () => ({ accepted: 0, duplicates: 0 }),
		};
		const module = fakeModule({
			activate: (host) => {
				// A module that tries to register regardless of the tier, and for a feature that does not exist.
				host.registerMemoryProvider("not_a_feature" as never, () => provider);
				host.registerMemoryProvider("brain", () => provider);
			},
		});
		const gate = new EditionGate({ loadModule: async () => module, memory: providers });
		await gate.setEntitlement({ ...SIGNED_IN, tier: "low" });
		expect(providers.hasFactory).toBe(false);
		expect(await providers.providerFor("/w")).toBeUndefined();
		await gate.setEntitlement(SIGNED_IN);
		expect(providers.hasFactory).toBe(true);
		expect(await providers.providerFor("/w")).toBe(provider);
		await gate.setEntitlement(SIGNED_OUT);
		expect(providers.hasFactory).toBe(false);
		expect(await providers.providerFor("/w")).toBeUndefined();
	});

	it("lets the ee module register a span exporter only for a feature that is on, asked before every span (F21)", async () => {
		const exporters = new TelemetryExporters();
		const spans: unknown[] = [];
		const exporter = { export: (span: unknown) => spans.push(span) };
		let created: unknown;
		const module = fakeModule({
			activate: (host) => {
				host.registerTelemetryExporter("not_a_feature" as never, exporter);
				host.registerTelemetryExporter("eyes", exporter);
				created = host.createOtlpExporter({ url: "http://127.0.0.1:9/v1/traces" });
			},
		});
		const gate = new EditionGate({ loadModule: async () => module, telemetry: exporters });
		await gate.setEntitlement({ ...SIGNED_IN, tier: "low" });
		expect(exporters.has("ee")).toBe(false);
		expect(exporters.active()).toEqual([]);
		await gate.setEntitlement(SIGNED_IN);
		expect(exporters.active()).toEqual([exporter]);
		expect(created).toBeInstanceOf(OtlpHttpExporter);
		// Another slot (the person's own OTLP destination) is not the gate's to clear.
		exporters.set("otlp", { export: () => {} });
		await gate.setEntitlement(SIGNED_OUT);
		expect(exporters.has("ee")).toBe(false);
		expect(exporters.has("otlp")).toBe(true);
	});

	it("lets the ee module register a sub-agent engine only for a feature that is on, asked before every use (F18)", async () => {
		const engines = new SubagentEngines();
		const engine: SubagentEngine = {
			run: async () => {
				throw new Error("not used");
			},
			steer: () => false,
			stop: () => false,
			list: () => [],
		};
		const module = fakeModule({
			activate: (host) => {
				host.registerSubagentEngine("subagents", { run: "nope" } as never);
				host.registerSubagentEngine("subagents", engine);
				// Refused: a feature that does not exist never replaces the real registration.
				host.registerSubagentEngine("not_a_feature" as never, { ...engine });
			},
		});
		const changes: number[] = [];
		engines.onChange(() => changes.push(changes.length));
		const gate = new EditionGate({ loadModule: async () => module, subagents: engines });
		await gate.setEntitlement({ ...SIGNED_IN, tier: "low" });
		expect(engines.engine()).toBeUndefined();
		await gate.setEntitlement(SIGNED_IN);
		expect(engines.engine()).toBe(engine);
		await gate.setEntitlement({ ...SIGNED_IN, fingersEnabled: false });
		expect(engines.engine()).toBeUndefined();
		await gate.setEntitlement(SIGNED_IN);
		expect(engines.engine()).toBe(engine);
		await gate.setEntitlement(SIGNED_OUT);
		expect(engines.engine()).toBeUndefined();
		expect(changes.length).toBeGreaterThan(0);
	});

	it("is core only without an ee module, whatever the tier", async () => {
		const gate = new EditionGate({ loadModule: async () => undefined });
		await gate.setEntitlement({ ...SIGNED_IN, tier: "high" });
		expect(gate.isOn()).toBe(false);
		expect(gate.state("subagents")).toEqual({ on: false, reason: "no_ee" });
		expect(gate.commandFeature("agents")).toBe("subagents");
		expect(gate.commandFeature("model")).toBeUndefined();
		expect(gate.commandFeature("constructor")).toBeUndefined();
	});

	it("drops the module's commands when it fails to activate, and loads the module once", async () => {
		const loadModule = vi.fn(async () =>
			fakeModule({
				activate: () => {
					throw new Error("boom");
				},
			}),
		);
		const errors: unknown[] = [];
		const gate = new EditionGate({ loadModule, onActivateError: (error) => errors.push(error) });
		await gate.setEntitlement(SIGNED_IN);
		await gate.setEntitlement(SIGNED_IN);
		expect(gate.commandHandler("agents")).toBeUndefined();
		expect(errors).toHaveLength(2);
		expect(loadModule).toHaveBeenCalledTimes(1);
	});

	it("tells listeners after a refresh", async () => {
		const gate = new EditionGate({ loadModule: async () => fakeModule(), now: () => NOW });
		const changes = vi.fn();
		gate.onChange(changes);
		await gate.refresh(source({ account: account(), org: ORG }));
		expect(changes).toHaveBeenCalledTimes(1);
		expect(gate.entitlement.tier).toBe("high");
		await gate.refresh(undefined);
		expect(gate.entitlement).toEqual(SIGNED_OUT);
	});
});

describe("the ee module loader", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fingers-ee-loader-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writeModule(path: string, text: string): void {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, text);
	}

	const VALID = `export const apiVersion = 7; export const matrixVersion = "x"; export function minimumTier() { return "low"; } export function activate() {}`;

	it("looks next to a binary, in a source checkout's ee/src, then in dist/ee", () => {
		const packageDir = join(dir, "packages", "coding-agent");
		expect(eeModuleCandidates({ packageDir, isBunBinary: false, execPath: "" })).toEqual([
			join(packageDir, "dist", "ee", "index.js"),
		]);
		mkdirSync(join(packageDir, "src"), { recursive: true });
		expect(eeModuleCandidates({ packageDir, isBunBinary: false, execPath: "" })).toEqual([
			join(dir, "ee", "src", "index.ts"),
			join(packageDir, "dist", "ee", "index.js"),
		]);
		expect(eeModuleCandidates({ packageDir, isBunBinary: true, execPath: join(dir, "bin", "fingers") })).toEqual([
			join(dir, "bin", "ee", "index.js"),
		]);
	});

	it("finds nothing in a core-only installation", async () => {
		const packageDir = join(dir, "pkg");
		mkdirSync(packageDir);
		expect(await loadEeModule({ packageDir, isBunBinary: false, execPath: "" })).toBeUndefined();
	});

	it("loads a built module from dist/ee, as named exports or as the default export", async () => {
		const packageDir = join(dir, "pkg");
		writeModule(join(packageDir, "dist", "ee", "index.js"), VALID);
		const named = await loadEeModule({ packageDir, isBunBinary: false, execPath: "" });
		expect(named?.matrixVersion).toBe("x");

		const other = join(dir, "pkg2");
		writeModule(
			join(other, "dist", "ee", "index.js"),
			`export default { apiVersion: 7, matrixVersion: "d", minimumTier: () => "low", activate() {} };`,
		);
		expect((await loadEeModule({ packageDir: other, isBunBinary: false, execPath: "" }))?.matrixVersion).toBe("d");
	});

	it("refuses a module built for another contract version, one without the exports, and one that throws", async () => {
		for (const [name, text] of [
			["v6", VALID.replace("apiVersion = 7", "apiVersion = 6")],
			["v8", VALID.replace("apiVersion = 7", "apiVersion = 8")],
			["partial", `export const apiVersion = 7; export const matrixVersion = "x";`],
			["throws", `throw new Error("broken ee");`],
		]) {
			const packageDir = join(dir, name);
			writeModule(join(packageDir, "dist", "ee", "index.js"), text);
			expect(await loadEeModule({ packageDir, isBunBinary: false, execPath: "" }), name).toBeUndefined();
		}
	});
});

describe("Connect's answer kept with the sign-in", () => {
	let fake: FakeConnect;
	let agentDir: string;

	beforeEach(async () => {
		agentDir = mkdtempSync(join(tmpdir(), "fingers-ee-auth-"));
		fake = await new FakeConnect().start();
	});

	afterEach(async () => {
		await fake.stop();
		rmSync(agentDir, { recursive: true, force: true });
	});

	function auth(clock: { now: number }) {
		return new VeyraAuth({
			issuer: fake.issuer,
			vault: openVeyraSessionVault({
				agentDir,
				issuer: fake.issuer,
				env: { FINGERS_CREDENTIAL_STORE: "keychain" },
				secretStore: store,
			}),
			apiUrl: fake.issuer,
			appVersion: "0.1.0",
			now: () => clock.now,
			sleep: async (ms) => {
				clock.now += ms;
			},
		});
	}
	const store = new InMemorySecretStore();

	it("keeps tier, Fingers on and the time in the keychain, and serves them offline for 72 hours", async () => {
		const clock = { now: Date.now() };
		const a = auth(clock);
		await a.login({ onCode: () => {}, signal: new AbortController().signal });
		fake.orgTier = "low";

		const online = await resolveEntitlement(a, { now: () => clock.now });
		expect(online).toMatchObject({ source: "connect", tier: "low", fingersEnabled: true, org: FAKE_ORG.id });
		expect(a.account()).toMatchObject({ tier: "low", fingersEnabled: true, entitlementCheckedAt: clock.now });

		// Connect down: the kept answer, read back from the keychain by a new process.
		fake.orgAnswer = { status: 503, body: { code: "unavailable" } };
		clock.now += 71 * HOUR;
		expect(await resolveEntitlement(auth(clock), { now: () => clock.now })).toMatchObject({
			source: "cache",
			tier: "low",
		});
		clock.now += 2 * HOUR;
		expect(await resolveEntitlement(auth(clock), { now: () => clock.now })).toMatchObject({
			source: "none",
			offline: true,
		});
	});

	it("drops the kept answer when Connect refuses the organization, and sees the app turned off", async () => {
		const clock = { now: Date.now() };
		const a = auth(clock);
		await a.login({ onCode: () => {}, signal: new AbortController().signal });
		await resolveEntitlement(a, { now: () => clock.now });
		expect(a.account()?.entitlementCheckedAt).toBe(clock.now);

		fake.orgApps = ["connect"];
		expect(await resolveEntitlement(a, { now: () => clock.now })).toMatchObject({ fingersEnabled: false });
		expect(a.account()?.fingersEnabled).toBe(false);

		fake.orgAnswer = { status: 403, body: { code: "permission_denied", title: "Forbidden" } };
		const refused = await resolveEntitlement(a, { now: () => clock.now });
		expect(refused).toMatchObject({ source: "none", fingersEnabled: false });
		expect(refused.denied).toContain("403");
		expect(a.account()?.entitlementCheckedAt).toBeUndefined();
		expect(a.account()?.fingersEnabled).toBeUndefined();

		// Offline afterwards: nothing kept to fall back to.
		fake.orgAnswer = { status: 503, body: {} };
		expect(await resolveEntitlement(a, { now: () => clock.now })).toMatchObject({ source: "none", offline: true });
	});
});
