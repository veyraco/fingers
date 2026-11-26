// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * The tier matrix and the ee module as the core loads it: which features each tier turns on, through the core's
 * real gate, and that the module fits the core's contract.
 */
import { describe, expect, it, vi } from "vitest";
import {
	EditionGate,
	EE_API_VERSION,
	EE_FEATURE_IDS,
	type EeEntitlement,
	type EeFeatureId,
	VEYRA_TIERS,
	type VeyraTier,
} from "../../packages/coding-agent/src/core/edition/index.ts";
import { asEeModule, loadEeModule } from "../../packages/coding-agent/src/core/edition/loader.ts";
import * as ee from "../src/index.ts";
import { TIER_MATRIX, TIER_MATRIX_VERSION } from "../src/tier-matrix.ts";

function entitlement(tier: VeyraTier): EeEntitlement {
	return {
		signedIn: true,
		source: "connect",
		org: "org_1",
		orgName: "Acme",
		tier,
		fingersEnabled: true,
		checkedAt: Date.now(),
	};
}

async function featuresOn(tier: VeyraTier): Promise<EeFeatureId[]> {
	const gate = new EditionGate({ loadModule: async () => asEeModule(ee) });
	await gate.setEntitlement(entitlement(tier));
	return gate.onFeatures();
}

describe("tier matrix", () => {
	it("gives every ee feature a known tier, and is versioned", () => {
		expect(Object.keys(TIER_MATRIX).sort()).toEqual([...EE_FEATURE_IDS].sort());
		for (const tier of Object.values(TIER_MATRIX)) expect(VEYRA_TIERS).toContain(tier);
		expect(TIER_MATRIX_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
		expect(ee.matrixVersion).toBe(TIER_MATRIX_VERSION);
	});

	it("Free: no ee feature (Connect's tier catalog has fingers.ee off on Free)", async () => {
		expect(await featuresOn("free")).toEqual([]);
	});

	it("Low: token saving", async () => {
		expect(await featuresOn("low")).toEqual(["token_saving"]);
	});

	it("Medium: + sub-agents, checkpoints, Brain, Eyes", async () => {
		expect(await featuresOn("medium")).toEqual(["token_saving", "subagents", "checkpoints", "brain", "eyes"]);
	});

	it("High: + organization hooks", async () => {
		expect(await featuresOn("high")).toEqual([...EE_FEATURE_IDS]);
	});

	it("never turns a feature off when the tier goes up", () => {
		for (const feature of EE_FEATURE_IDS) {
			const from = VEYRA_TIERS.indexOf(TIER_MATRIX[feature]);
			for (const [index, tier] of VEYRA_TIERS.entries()) {
				expect(index >= from, `${feature} on ${tier}`).toBe(VEYRA_TIERS.indexOf(tier) >= from);
			}
		}
	});

	it("keeps every feature off when Fingers is off for the organization or nobody is signed in", async () => {
		const gate = new EditionGate({ loadModule: async () => asEeModule(ee) });
		await gate.setEntitlement({ ...entitlement("high"), fingersEnabled: false });
		expect(gate.onFeatures()).toEqual([]);
		await gate.setEntitlement({ signedIn: false, source: "none", fingersEnabled: false });
		expect(gate.onFeatures()).toEqual([]);
	});
});

describe("the ee module", () => {
	it("fits the core's contract version", () => {
		expect(ee.apiVersion).toBe(EE_API_VERSION);
		expect(asEeModule(ee)).toBeDefined();
	});

	it("is what the core finds in this source checkout", async () => {
		const loaded = await loadEeModule();
		expect(loaded?.matrixVersion).toBe(TIER_MATRIX_VERSION);
	});

	it("registers /agents only while sub-agents are on, and lists them when run", async () => {
		const gate = new EditionGate({ loadModule: async () => asEeModule(ee) });
		await gate.setEntitlement(entitlement("low"));
		expect(gate.commandHandler("agents")).toBeUndefined();
		await gate.setEntitlement(entitlement("medium"));
		const handler = gate.commandHandler("agents");
		expect(handler).toBeTypeOf("function");
		const showStatus = vi.fn();
		await handler?.({
			args: "",
			entitlement: gate.entitlement,
			cwd: "/work/web",
			showStatus,
			showWarning: vi.fn(),
		});
		// F18: /agents lists this process' sub-agents (none yet) instead of the placeholder line.
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("No sub-agents yet in this session."));
	});
});
