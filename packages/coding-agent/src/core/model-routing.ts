/**
 * Cheaper-model routing of sub-tasks (F16): before a sub-task runs, the core offers the ee routing hooks the current
 * provider's other priced chat models that have room for it, and runs the sub-task on the one a hook picks. The rule
 * that picks is ee (token saving); this file only builds the offer, checks the pick and reports the outcome.
 *
 * The core routes compaction summaries (`summarise`); sub-agents (F18) route `search` and `review` the same way.
 * Only the terminal app's gate fills the hooks, so managed RPC, print and JSON modes never route.
 */
import { type Api, calculateCost, isModelType, type Model, type Usage } from "@veyraco/fingers-ai";
import { isListPriced } from "./budget.ts";
import { type EditionToolHooks, editionToolHooks } from "./edition/tool-hooks.ts";
import type { EeModelFacts, EeRouteOutcome, EeSubTaskClass } from "./edition/types.ts";
import { isVirtualModel } from "./virtual-models.ts";

/** What the core needs from the model runtime to build the offer. */
export interface RoutingModelSource {
	getModels(providerId?: string): readonly Model<Api>[];
}

export interface SubTaskRouteOptions {
	taskClass: EeSubTaskClass;
	/** The physical model the sub-task runs on unless a hook picks another. */
	model: Model<Api>;
	models: RoutingModelSource;
	/** Estimated tokens the request needs in the context window (input plus output). */
	minContextTokens: number;
	/** Tokens the sub-task may write. */
	minOutputTokens: number;
	/** Default: this process' hooks (filled by the terminal app's gate). */
	hooks?: EditionToolHooks;
}

export function modelFacts(model: Model<Api>): EeModelFacts {
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		reasoning: model.reasoning,
		input: model.input.filter((kind): kind is "text" | "image" => kind === "text" || kind === "image"),
		cost: {
			input: model.cost.input,
			output: model.cost.output,
			cacheRead: model.cost.cacheRead,
			cacheWrite: model.cost.cacheWrite,
		},
	};
}

/**
 * The models a sub-task may move to: the same provider (the same credentials and endpoint), a chat model that is not
 * virtual, takes text, has a list price, and has room for the request and the output.
 */
export function routingCandidates(options: SubTaskRouteOptions): Model<Api>[] {
	const { model, minContextTokens, minOutputTokens } = options;
	return options.models.getModels(model.provider).filter((candidate) => {
		if (candidate.provider !== model.provider || candidate.id === model.id) return false;
		if (!isModelType(candidate, "chat")) return false;
		if (isVirtualModel(candidate) || !candidate.input.includes("text") || !isListPriced(candidate)) return false;
		return candidate.contextWindow >= minContextTokens && candidate.maxTokens >= minOutputTokens;
	});
}

/**
 * The model to run a sub-task on: the hooks' pick among the candidates, or undefined to keep `model`. Never routes
 * away from a virtual model (its router decides) or from a model without a list price (no saving can be told).
 */
export function routeSubTask(options: SubTaskRouteOptions): Model<Api> | undefined {
	const hooks = options.hooks ?? editionToolHooks;
	if (!hooks.active) return undefined;
	const { model } = options;
	if (isVirtualModel(model) || !isListPriced(model)) return undefined;
	const candidates = routingCandidates(options);
	if (candidates.length === 0) return undefined;
	const choice = hooks.routeModel({
		taskClass: options.taskClass,
		current: modelFacts(model),
		candidates: candidates.map(modelFacts),
		minContextTokens: options.minContextTokens,
		minOutputTokens: options.minOutputTokens,
	});
	if (!choice) return undefined;
	return candidates.find((candidate) => candidate.provider === choice.provider && candidate.id === choice.id);
}

function costOf(model: Model<Api>, usage: Usage): number {
	const copy: Usage = { ...usage, cost: { ...usage.cost } };
	return calculateCost(model, copy).total;
}

/** What a routed sub-task cost, and what the same tokens would have cost on the model it was routed from. */
export function routeOutcome(
	taskClass: EeSubTaskClass,
	from: Model<Api>,
	to: Model<Api>,
	usage: Usage,
): EeRouteOutcome {
	return {
		taskClass,
		from: { provider: from.provider, id: from.id },
		to: { provider: to.provider, id: to.id },
		costUsd: costOf(to, usage),
		wouldHaveCostUsd: costOf(from, usage),
		tokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
	};
}
