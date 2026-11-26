/**
 * Cheaper-model routing of sub-tasks (F16): the core offers the ee routing hooks the current provider's other priced
 * models with room for the sub-task, runs the sub-task on the hook's pick and reports the outcome. These tests use
 * stand-in hooks, so they pass without ee/.
 */
import type { Api, Model } from "@veyraco/fingers-ai";
import { fauxAssistantMessage } from "@veyraco/fingers-ai";
import { afterEach, describe, expect, it } from "vitest";
import { EditionToolHooks, editionToolHooks } from "../src/core/edition/tool-hooks.ts";
import type { EeRouteOutcome, EeRouteRequest, EeToolHooks } from "../src/core/edition/types.ts";
import { modelFacts, routeOutcome, routeSubTask, routingCandidates } from "../src/core/model-routing.ts";
import { VIRTUAL_MODEL_API } from "../src/core/virtual-models.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function model(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		...overrides,
	} as Model<Api>;
}

const BIG = model("big");
const SMALL = model("small", { cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } });
const TINY_WINDOW = model("tiny-window", {
	cost: { input: 0.1, output: 0.5, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_000,
});
const FREE = model("free", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
const NO_TEXT = model("image-only", {
	input: ["image"] as never,
	cost: { input: 0.2, output: 1, cacheRead: 0, cacheWrite: 0 },
});
const VIRTUAL = model("auto", { api: VIRTUAL_MODEL_API as Api });
const OTHER_PROVIDER = model("cheap-elsewhere", {
	provider: "openai",
	cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 },
});
const SHORT_OUTPUT = model("short-output", {
	maxTokens: 1_000,
	cost: { input: 0.5, output: 2, cacheRead: 0, cacheWrite: 0 },
});

const MODELS = { getModels: () => [BIG, SMALL, TINY_WINDOW, FREE, NO_TEXT, VIRTUAL, OTHER_PROVIDER, SHORT_OUTPUT] };

function hooksWith(routing: EeToolHooks, on = true): EditionToolHooks {
	const hooks = new EditionToolHooks();
	hooks.set([{ feature: "token_saving", hooks: routing }], () => on);
	return hooks;
}

const options = {
	taskClass: "summarise" as const,
	model: BIG,
	models: MODELS,
	minContextTokens: 20_000,
	minOutputTokens: 13_000,
};

describe("routeSubTask", () => {
	it("offers only the same provider's priced text models with room for the request and the output", () => {
		expect(routingCandidates(options).map((candidate) => candidate.id)).toEqual(["small"]);
		expect(routingCandidates({ ...options, minContextTokens: 1_000, minOutputTokens: 500 }).map((m) => m.id)).toEqual(
			["small", "tiny-window", "short-output"],
		);
	});

	it("runs the sub-task on the hook's pick and hands the hook facts without credentials or URLs", () => {
		const requests: EeRouteRequest[] = [];
		const hooks = hooksWith({
			routeModel: (request) => {
				requests.push(request);
				return { provider: "anthropic", id: "small" };
			},
		});
		expect(routeSubTask({ ...options, hooks })).toBe(SMALL);
		expect(requests).toEqual([
			{
				taskClass: "summarise",
				current: {
					provider: "anthropic",
					id: "big",
					name: "big",
					contextWindow: 200_000,
					maxTokens: 64_000,
					reasoning: true,
					input: ["text", "image"],
					cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
				},
				candidates: [expect.objectContaining({ id: "small", provider: "anthropic" })],
				minContextTokens: 20_000,
				minOutputTokens: 13_000,
			},
		]);
		expect(JSON.stringify(requests)).not.toContain("baseUrl");
	});

	it("keeps the current model when no hook is on, the pick is not offered, or the current model cannot be priced", () => {
		const pickOther = { routeModel: () => ({ provider: "openai", id: "cheap-elsewhere" }) };
		const pickSmall = { routeModel: () => ({ provider: "anthropic", id: "small" }) };
		expect(routeSubTask({ ...options, hooks: hooksWith(pickSmall, false) })).toBeUndefined();
		expect(routeSubTask({ ...options, hooks: hooksWith(pickOther) })).toBeUndefined();
		expect(routeSubTask({ ...options, hooks: hooksWith({ routeModel: () => undefined }) })).toBeUndefined();
		expect(
			routeSubTask({
				...options,
				hooks: hooksWith({
					routeModel: () => {
						throw new Error("broken rule");
					},
				}),
			}),
		).toBeUndefined();
		expect(routeSubTask({ ...options, model: FREE, hooks: hooksWith(pickSmall) })).toBeUndefined();
		expect(routeSubTask({ ...options, model: VIRTUAL, hooks: hooksWith(pickSmall) })).toBeUndefined();
	});

	it("lets the first hook that names an offered candidate decide; other answers are skipped", () => {
		const hooks = new EditionToolHooks();
		const seen: string[] = [];
		hooks.set(
			[
				{ feature: "token_saving", hooks: { routeModel: () => ({ provider: "openai", id: "cheap-elsewhere" }) } },
				{ feature: "token_saving", hooks: { routeModel: () => ({ provider: "anthropic", id: "big" }) } },
				{
					feature: "token_saving",
					hooks: {
						routeModel: (request) => {
							seen.push(request.taskClass);
							return { provider: "anthropic", id: "small" };
						},
					},
				},
				{ feature: "token_saving", hooks: { routeModel: () => ({ provider: "anthropic", id: "tiny-window" }) } },
			],
			() => true,
		);
		const request: EeRouteRequest = {
			taskClass: "review",
			current: modelFacts(BIG),
			candidates: [modelFacts(SMALL), modelFacts(TINY_WINDOW)],
			minContextTokens: 1,
			minOutputTokens: 1,
		};
		expect(hooks.routeModel(request)).toEqual({ provider: "anthropic", id: "small" });
		expect(seen).toEqual(["review"]);
		expect(hooks.routeModel({ ...request, candidates: [] })).toBeUndefined();
	});

	it("prices the outcome at both models' list prices", () => {
		const outcome = routeOutcome("summarise", BIG, SMALL, {
			input: 100_000,
			output: 2_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 102_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		expect(outcome).toEqual({
			taskClass: "summarise",
			from: { provider: "anthropic", id: "big" },
			to: { provider: "anthropic", id: "small" },
			costUsd: expect.closeTo(0.11, 10),
			wouldHaveCostUsd: expect.closeTo(1.1, 10),
			tokens: 102_000,
		});
	});
});

describe("compaction summaries on a cheaper model", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		editionToolHooks.clear();
		editionToolHooks.takeNotices();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function conversation(settings: Record<string, unknown> = {}) {
		const harness = await createHarness({
			models: [
				{ id: "big", cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }, contextWindow: 200_000 },
				{ id: "small", cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }, contextWindow: 200_000 },
			],
			settings: { compaction: { enabled: true, reserveTokens: 4_000, keepRecentTokens: 1 }, ...settings },
		});
		harnesses.push(harness);
		harness.setResponses([1, 2, 3].map((n) => fauxAssistantMessage(`answer ${n} ${"x".repeat(400)}`)));
		for (const n of [1, 2, 3]) await harness.session.prompt(`question ${n} ${"y".repeat(400)}`);
		return harness;
	}

	function routeToSmall(outcomes: EeRouteOutcome[]): void {
		editionToolHooks.set(
			[
				{
					feature: "token_saving",
					hooks: {
						routeModel: (request) => request.candidates.find((candidate) => candidate.id === "small"),
						afterRoute: (outcome) => {
							outcomes.push(outcome);
							return `routed to ${outcome.to.id}`;
						},
					},
				},
			],
			() => true,
		);
	}

	function summaryOn(seen: string[], fail?: string) {
		return (_context: unknown, _options: unknown, _state: unknown, requestModel: Model<string>) => {
			seen.push(requestModel.id);
			if (requestModel.id === fail) {
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 invalid_request_error" });
			}
			return fauxAssistantMessage("## Goal\nAnswer the questions.");
		};
	}

	it("summarises on the hook's pick and reports what that saved", async () => {
		const harness = await conversation();
		const outcomes: EeRouteOutcome[] = [];
		routeToSmall(outcomes);
		const seen: string[] = [];
		harness.setResponses([summaryOn(seen), summaryOn(seen)]);
		const result = await harness.session.compact();
		// The cut falls inside the last turn: two summary calls (the history, then the turn prefix), both routed.
		expect(seen).toEqual(["small", "small"]);
		expect(result.summary).toContain("Answer the questions.");
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({
			taskClass: "summarise",
			from: { id: "big" },
			to: { id: "small" },
		});
		expect(outcomes[0].tokens).toBeGreaterThan(0);
		expect(outcomes[0].wouldHaveCostUsd).toBeCloseTo(outcomes[0].costUsd * 10, 10);
		expect(editionToolHooks.takeNotices()).toEqual(["routed to small"]);
		// The conversation itself stays on the selected model.
		expect(harness.session.model?.id).toBe("big");
	});

	it("keeps the selected model with modelRouting off or without a hook that is on", async () => {
		const off = await conversation({ modelRouting: false });
		routeToSmall([]);
		const seen: string[] = [];
		off.setResponses([summaryOn(seen), summaryOn(seen)]);
		await off.session.compact();
		expect(seen).toEqual(["big", "big"]);

		editionToolHooks.clear();
		const core = await conversation();
		core.setResponses([summaryOn(seen), summaryOn(seen)]);
		await core.session.compact();
		expect(seen).toEqual(["big", "big", "big", "big"]);
		expect(editionToolHooks.takeNotices()).toEqual([]);
	});

	it("summarises on the selected model when the cheaper one fails", async () => {
		const harness = await conversation();
		const outcomes: EeRouteOutcome[] = [];
		routeToSmall(outcomes);
		const seen: string[] = [];
		harness.setResponses([1, 2, 3].map(() => summaryOn(seen, "small")));
		const result = await harness.session.compact();
		expect(seen).toEqual(["small", "big", "big"]);
		expect(result.summary).toContain("Answer the questions.");
		expect(outcomes).toEqual([]);
	});
});
