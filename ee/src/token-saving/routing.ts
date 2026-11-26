// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * Cheaper-model routing (F16): a sub-task (a compaction summary today; search and review sub-agents with F18) runs on
 * a cheaper model of the same provider when one fits it. The core offers the candidates (same provider and
 * credentials, priced, room for the request and the output); this rule picks one.
 *
 * Prices are compared as a blended price per million tokens, `(3 x input + output) / 4` (sub-task requests read far
 * more than they write). A candidate must cost at most `MAX_PRICE_SHARE` of the current model, so a pick saves enough
 * to be worth a different model. Per class:
 *
 * - summarise and search: the cheapest candidate (summaries and look-ups do not need the strongest model);
 * - review: the strongest candidate that still costs at most `MAX_PRICE_SHARE`, and at least `REVIEW_MIN_PRICE_SHARE`
 *   of the current model; a reasoning model reviews only on a reasoning model.
 *
 * On a provider that serves several vendors (model ids `vendor/model`, e.g. OpenRouter), only the current model's
 * vendor is considered. Ties go to the shorter id (an alias over a dated snapshot), then the later id.
 *
 * The numbers are placeholders like the tier matrix: change ROUTING_RULES_VERSION with every change.
 */
import type { EeModelFacts, EeRouteChoice, EeRouteOutcome, EeRouteRequest, EeSubTaskClass } from "@veyraco/fingers";

export const ROUTING_RULES_VERSION = "2026-11-26.1";

/** A pick must cost at most this share of the current model's blended price. */
export const MAX_PRICE_SHARE = 0.8;

/** A review sub-task never goes below this share of the current model's blended price. */
export const REVIEW_MIN_PRICE_SHARE = 0.25;

/** Dollars per million tokens, weighted for sub-tasks that read more than they write. */
export function blendedPrice(model: EeModelFacts): number {
	return (3 * model.cost.input + model.cost.output) / 4;
}

function vendor(id: string): string | undefined {
	const slash = id.indexOf("/");
	return slash > 0 ? id.slice(0, slash) : undefined;
}

function byTieBreak(a: EeModelFacts, b: EeModelFacts): number {
	if (a.id.length !== b.id.length) return a.id.length - b.id.length;
	return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** The candidates the rule may pick for `taskClass`, cheapest first. */
export function eligibleModels(request: EeRouteRequest): EeModelFacts[] {
	const current = blendedPrice(request.current);
	if (!(current > 0)) return [];
	const currentVendor = vendor(request.current.id);
	const minShare = request.taskClass === "review" ? REVIEW_MIN_PRICE_SHARE : 0;
	return request.candidates
		.filter((candidate) => {
			if (candidate.provider !== request.current.provider || candidate.id === request.current.id) return false;
			if (currentVendor !== undefined && vendor(candidate.id) !== currentVendor) return false;
			if (!candidate.input.includes("text")) return false;
			if (candidate.contextWindow < request.minContextTokens || candidate.maxTokens < request.minOutputTokens) {
				return false;
			}
			if (request.taskClass === "review" && request.current.reasoning && !candidate.reasoning) return false;
			const price = blendedPrice(candidate);
			return price > 0 && price <= current * MAX_PRICE_SHARE && price >= current * minShare;
		})
		.sort((a, b) => blendedPrice(a) - blendedPrice(b) || byTieBreak(a, b));
}

/** The model to run the sub-task on, or undefined to keep the current one. */
export function routeModel(request: EeRouteRequest): EeRouteChoice | undefined {
	const eligible = eligibleModels(request);
	if (eligible.length === 0) return undefined;
	let pick = eligible[0];
	if (request.taskClass === "review") {
		const strongest = blendedPrice(eligible[eligible.length - 1]);
		pick = eligible.filter((model) => blendedPrice(model) === strongest).sort(byTieBreak)[0];
	}
	return { provider: pick.provider, id: pick.id };
}

const TASK_LABELS: Record<EeSubTaskClass, string> = {
	summarise: "the compaction summary",
	search: "the search sub-task",
	review: "the review sub-task",
};

function formatUsd(usd: number): string {
	return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** Dollars routing saved on one sub-task (0 when the cheaper model did not cost less). */
export function routingSaving(outcome: EeRouteOutcome): number {
	const saved = outcome.wouldHaveCostUsd - outcome.costUsd;
	return Number.isFinite(saved) && saved > 0 ? saved : 0;
}

/** "Token saving: the compaction summary ran on B instead of A ($0.01 instead of $0.40)." */
export function routingLine(outcome: EeRouteOutcome): string {
	return `Token saving: ${TASK_LABELS[outcome.taskClass]} ran on ${outcome.to.id} instead of ${outcome.from.id} (${formatUsd(outcome.costUsd)} instead of ${formatUsd(outcome.wouldHaveCostUsd)}).`;
}
