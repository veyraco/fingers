// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * Cheaper-model routing (F16): the routing rule per sub-task class, the ledger entry and the line it writes, and a
 * compaction summary routed through the real gate, ee module and core in a session.
 */
import type { EeEntitlement, EeModelFacts, EeRouteRequest, SavingsEntry } from "@veyraco/fingers";
import { fauxAssistantMessage, type Model } from "@veyraco/fingers-ai";
import { afterEach, describe, expect, it } from "vitest";
import { EditionGate } from "../../packages/coding-agent/src/core/edition/gate.ts";
import { editionToolHooks } from "../../packages/coding-agent/src/core/edition/tool-hooks.ts";
import { SavingsLedger } from "../../packages/coding-agent/src/core/savings-ledger.ts";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.ts";
import * as ee from "../src/index.ts";
import { TokenSaving } from "../src/token-saving/index.ts";
import {
	blendedPrice,
	MAX_PRICE_SHARE,
	REVIEW_MIN_PRICE_SHARE,
	routeModel,
	routingLine,
	routingSaving,
} from "../src/token-saving/routing.ts";

function facts(id: string, input: number, output: number, overrides: Partial<EeModelFacts> = {}): EeModelFacts {
	return {
		provider: "anthropic",
		id,
		name: id,
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		reasoning: true,
		input: ["text", "image"],
		cost: { input, output, cacheRead: input / 10, cacheWrite: input * 1.25 },
		...overrides,
	};
}

// Shaped like the Anthropic catalog of 2026-11 (opus 4/20, sonnet 2/10, haiku 1/5 and 0.1/0.5).
const OPUS = facts("claude-opus-5-5", 4, 20);
const SONNET = facts("claude-sonnet-5-5", 2, 10);
const HAIKU_45 = facts("claude-haiku-4-5", 1, 5, { contextWindow: 200_000 });
const HAIKU_45_DATED = facts("claude-haiku-4-5-20251001", 1, 5, { contextWindow: 200_000 });
const HAIKU_55 = facts("claude-haiku-5-5", 0.1, 0.5);

function request(taskClass: EeRouteRequest["taskClass"], candidates: EeModelFacts[], current = OPUS): EeRouteRequest {
	return { taskClass, current, candidates, minContextTokens: 50_000, minOutputTokens: 13_000 };
}

describe("routing rule", () => {
	it("summarises and searches on the cheapest candidate", () => {
		const candidates = [SONNET, HAIKU_45, HAIKU_55];
		expect(routeModel(request("summarise", candidates))).toEqual({ provider: "anthropic", id: "claude-haiku-5-5" });
		expect(routeModel(request("search", candidates))).toEqual({ provider: "anthropic", id: "claude-haiku-5-5" });
	});

	it("reviews on the strongest candidate between a quarter and 80% of the current price", () => {
		expect(routeModel(request("review", [SONNET, HAIKU_45, HAIKU_55]))).toEqual({
			provider: "anthropic",
			id: "claude-sonnet-5-5",
		});
		// Haiku 4.5 costs 25% of Opus 5.5: still a reviewer; Haiku 5.5 (2.5%) never is.
		expect(blendedPrice(HAIKU_45) / blendedPrice(OPUS)).toBeCloseTo(REVIEW_MIN_PRICE_SHARE, 10);
		expect(routeModel(request("review", [HAIKU_45, HAIKU_55]))).toEqual({
			provider: "anthropic",
			id: "claude-haiku-4-5",
		});
		expect(routeModel(request("review", [HAIKU_55]))).toBeUndefined();
		// A reasoning model reviews only on a reasoning model.
		const plain = facts("claude-sonnet-plain", 2, 10, { reasoning: false });
		expect(routeModel(request("review", [plain]))).toBeUndefined();
		expect(routeModel(request("summarise", [plain]))).toEqual({ provider: "anthropic", id: "claude-sonnet-plain" });
	});

	it("routes only when the pick costs at most 80% of the current model", () => {
		const almost = facts("claude-opus-almost", 3.3, 16.5);
		expect(blendedPrice(almost) / blendedPrice(OPUS)).toBeGreaterThan(MAX_PRICE_SHARE);
		expect(routeModel(request("summarise", [almost]))).toBeUndefined();
		expect(routeModel(request("summarise", [OPUS]))).toBeUndefined();
		expect(routeModel(request("summarise", [], OPUS))).toBeUndefined();
		expect(routeModel(request("summarise", [HAIKU_55], facts("free", 0, 0)))).toBeUndefined();
	});

	it("checks room, text input and provider itself too", () => {
		expect(routeModel(request("summarise", [{ ...HAIKU_55, contextWindow: 40_000 }]))).toBeUndefined();
		expect(routeModel(request("summarise", [{ ...HAIKU_55, maxTokens: 8_000 }]))).toBeUndefined();
		expect(routeModel(request("summarise", [{ ...HAIKU_55, input: ["image"] }]))).toBeUndefined();
		expect(routeModel(request("summarise", [{ ...HAIKU_55, provider: "openai" }]))).toBeUndefined();
	});

	it("stays with the current vendor on a provider that serves several, and prefers an alias over a snapshot", () => {
		const current = facts("anthropic/claude-opus-5-5", 4, 20, { provider: "openrouter" });
		const otherVendor = facts("tiny/model-1b", 0.01, 0.02, { provider: "openrouter" });
		const sameVendor = facts("anthropic/claude-haiku-5-5", 0.1, 0.5, { provider: "openrouter" });
		expect(routeModel(request("summarise", [otherVendor, sameVendor], current))).toEqual({
			provider: "openrouter",
			id: "anthropic/claude-haiku-5-5",
		});
		expect(routeModel(request("summarise", [HAIKU_45_DATED, HAIKU_45]))).toEqual({
			provider: "anthropic",
			id: "claude-haiku-4-5",
		});
	});
});

describe("routing outcome", () => {
	const outcome = {
		taskClass: "summarise" as const,
		from: { provider: "anthropic", id: "claude-opus-5-5" },
		to: { provider: "anthropic", id: "claude-haiku-5-5" },
		costUsd: 0.0123,
		wouldHaveCostUsd: 0.492,
		tokens: 120_000,
	};

	it("writes the dollars saved to the ledger and says where the sub-task ran", () => {
		const saving = new TokenSaving();
		const entries: SavingsEntry[] = [];
		saving.attach({ recordSaving: (entry: SavingsEntry) => entries.push(entry) } as never);
		expect(saving.hooks.afterRoute?.(outcome)).toBe(
			"Token saving: the compaction summary ran on claude-haiku-5-5 instead of claude-opus-5-5 ($0.01 instead of $0.49).",
		);
		expect(entries).toEqual([{ technique: "model_routing", tokens: 0, costUsd: 0.492 - 0.0123 }]);
		// Nothing saved, nothing recorded.
		saving.hooks.afterRoute?.({ ...outcome, costUsd: 0.5 });
		expect(entries).toHaveLength(1);
		expect(routingSaving({ ...outcome, costUsd: Number.NaN })).toBe(0);
		expect(routingLine({ ...outcome, taskClass: "review", costUsd: 0.004 })).toContain("the review sub-task ran on");
		expect(routingLine({ ...outcome, costUsd: 0.004 })).toContain("($0.0040 instead of $0.49)");
	});
});

const LOW: EeEntitlement = {
	signedIn: true,
	source: "connect",
	org: "org_acme",
	orgName: "Acme",
	tier: "low",
	fingersEnabled: true,
};

describe("a compaction summary routed by token saving", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		editionToolHooks.clear();
		editionToolHooks.takeNotices();
		ee.tokenSaving.reset();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function compactWith(entitlement: EeEntitlement | undefined) {
		const savings = new SavingsLedger();
		if (entitlement) {
			const gate = new EditionGate({ loadModule: async () => ee, toolHooks: editionToolHooks, savings });
			await gate.setEntitlement(entitlement);
		}
		const harness = await createHarness({
			models: [
				{ id: "big", cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 }, contextWindow: 200_000 },
				{
					id: "small",
					cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
					contextWindow: 200_000,
				},
			],
			settings: { compaction: { enabled: true, reserveTokens: 4_000, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([1, 2, 3].map((n) => fauxAssistantMessage(`answer ${n} ${"x".repeat(2_000)}`)));
		for (const n of [1, 2, 3]) await harness.session.prompt(`question ${n} ${"y".repeat(2_000)}`);
		const seen: string[] = [];
		const summary = (_context: unknown, _options: unknown, _state: unknown, model: Model<string>) => {
			seen.push(model.id);
			return fauxAssistantMessage("## Goal\nAnswer the questions.");
		};
		harness.setResponses([summary, summary]);
		await harness.session.compact();
		return { seen, savings, notices: editionToolHooks.takeNotices() };
	}

	it("runs the summary on the cheaper model with token saving on, and records the saving", async () => {
		const routed = await compactWith(LOW);
		expect(routed.seen).toEqual(["small", "small"]);
		const totals = routed.savings.totals();
		expect(totals.byTechnique.model_routing.count).toBe(1);
		expect(totals.byTechnique.model_routing.costUsd).toBeGreaterThan(0);
		expect(routed.notices).toHaveLength(1);
		expect(routed.notices[0]).toMatch(
			/^Token saving: the compaction summary ran on small instead of big \(\$\d+\.\d+ instead of \$\d+\.\d+\)\.$/,
		);
	});

	it("keeps the summary on the selected model without token saving", async () => {
		const core = await compactWith(undefined);
		expect(core.seen).toEqual(["big", "big"]);
		expect(core.savings.totals().costUsd).toBe(0);
		expect(core.notices).toEqual([]);
		const free = await compactWith({ ...LOW, tier: "free" });
		expect(free.seen).toEqual(["big", "big"]);
	});
});
