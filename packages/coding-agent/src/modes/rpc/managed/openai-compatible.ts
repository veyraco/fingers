/**
 * The contract's `openai-compatible` provider: an OpenAI chat-completions endpoint that only the host knows.
 *
 * Problem: no catalog lists the models of such an endpoint, so `configure` with
 * `{provider: "openai-compatible", model_id: "custom-model-1"}` found no model and failed with
 * "Unknown model", and every run on an OpenAI-compatible connection ended before it started.
 *
 * Fingers builds the model itself from what the host sends: the id from `configure.model.model_id`, the
 * endpoint from `credentials.base_url`. The contract orders `configure` before `credentials`, so the model
 * starts without a base URL; the `credentials` message points it at `base_url` (`applyCredentials`, as for
 * every provider), and a request before that fails instead of going to a default endpoint.
 *
 * The contract carries no context window, output limit, price or capability for the model, so the model
 * gets the defaults of a custom model in models.json (`modelFromJson` in core/provider-composer.ts): text
 * input, no reasoning, a 128000-token context window, 16384 output tokens, price 0 (usage reports
 * `cost_source: unknown`; the host counts the cost), and OpenAI compatibility detected from the base URL.
 */
import {
	type Api,
	createProvider,
	envApiKeyAuth,
	lazyStream,
	type Model,
	ModelsError,
	type Provider,
	type ProviderStreams,
} from "@veyraco/fingers-ai";
import { openAICompletionsApi } from "@veyraco/fingers-ai/api/openai-completions.lazy";

export const OPENAI_COMPATIBLE_PROVIDER = "openai-compatible";

/** Defaults of a models.json custom model, for what the contract does not carry. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

/** The OpenAI chat-completions API, refusing a request while the model has no base URL. */
function requireBaseUrl(api: ProviderStreams): ProviderStreams {
	const refuse = (model: Model<Api>, signal: AbortSignal | undefined) =>
		lazyStream(
			model,
			async () => {
				throw new ModelsError(
					"provider",
					`No base URL for ${model.provider}/${model.id}: the host names the endpoint in credentials.base_url`,
				);
			},
			undefined,
			signal,
		);
	return {
		stream: (model, context, options) =>
			model.baseUrl ? api.stream(model, context, options) : refuse(model, options?.signal),
		streamSimple: (model, context, options) =>
			model.baseUrl ? api.streamSimple(model, context, options) : refuse(model, options?.signal),
	};
}

/**
 * The `openai-compatible` provider with one model, `modelId`. Its key and base URL come only from the
 * host's `credentials` message: no environment variable or stored credential is read for it.
 */
export function openAICompatibleProvider(modelId: string): Provider<"openai-completions"> {
	const model: Model<"openai-completions"> = {
		id: modelId,
		name: modelId,
		api: "openai-completions",
		provider: OPENAI_COMPATIBLE_PROVIDER,
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	};
	return createProvider({
		id: OPENAI_COMPATIBLE_PROVIDER,
		name: "OpenAI-compatible",
		auth: { apiKey: envApiKeyAuth("OpenAI-compatible API key", []) },
		models: [model],
		api: requireBaseUrl(openAICompletionsApi()),
	});
}
