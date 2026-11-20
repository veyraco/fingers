/**
 * Claude on Google Vertex AI: the Anthropic Messages API, sent to Vertex's rawPredict endpoints with a
 * Google access token from Application Default Credentials.
 *
 * Requests are built by the anthropic-messages implementation (same streaming, tools, thinking, usage,
 * prompt caching) and rewritten on the way out, as Anthropic's Vertex SDK does:
 * - POST {base}/v1/messages -> POST https://{location}-aiplatform.googleapis.com/v1/projects/{project}/
 *   locations/{location}/publishers/anthropic/models/{model}:streamRawPredict (rawPredict when not streaming;
 *   the "global" location uses https://aiplatform.googleapis.com)
 * - the model moves from the body into the URL; the body gains anthropic_version "vertex-2023-10-16"
 * - x-api-key is replaced by Authorization: Bearer <Google access token>
 */

import type { FetchFunction, Model, ProviderEnv, SimpleStreamOptions, StreamFunction } from "../types.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import {
	type AnthropicOptions,
	stream as anthropicStream,
	streamSimple as anthropicStreamSimple,
} from "./anthropic-messages.ts";
import { getVertexToken } from "./vertex-token.ts";

export const VERTEX_ANTHROPIC_VERSION = "vertex-2023-10-16";
/** Placeholder the Anthropic client gets as its key; the fetch wrapper swaps it for the Google token. */
const VERTEX_KEY_PLACEHOLDER = "vertex-adc";

export interface VertexAnthropicTarget {
	project: string;
	location: string;
}

export function resolveVertexTarget(env?: ProviderEnv): VertexAnthropicTarget {
	const project =
		getProviderEnvValue("GOOGLE_CLOUD_PROJECT", env) ||
		getProviderEnvValue("ANTHROPIC_VERTEX_PROJECT_ID", env) ||
		getProviderEnvValue("GCLOUD_PROJECT", env);
	if (!project) throw new Error("Claude on Vertex AI needs a project. Set GOOGLE_CLOUD_PROJECT.");
	const location =
		getProviderEnvValue("CLOUD_ML_REGION", env) || getProviderEnvValue("GOOGLE_CLOUD_LOCATION", env) || "global";
	return { project, location };
}

/** Vertex publishes dated Claude models as `claude-x@YYYYMMDD`; undated ids are used as they are. */
export function toVertexModelId(modelId: string): string {
	return modelId.replace(/-(\d{8})$/, "@$1");
}

export function vertexEndpoint(target: VertexAnthropicTarget, modelId: string, streaming: boolean): string {
	const host =
		target.location === "global" ? "aiplatform.googleapis.com" : `${target.location}-aiplatform.googleapis.com`;
	const specifier = streaming ? "streamRawPredict" : "rawPredict";
	return `https://${host}/v1/projects/${encodeURIComponent(target.project)}/locations/${encodeURIComponent(target.location)}/publishers/anthropic/models/${encodeURIComponent(toVertexModelId(modelId))}:${specifier}`;
}

/** Wrap a fetch so Anthropic Messages requests go to Vertex. Other requests pass through untouched. */
export function vertexFetch(
	target: VertexAnthropicTarget,
	env: ProviderEnv | undefined,
	inner?: FetchFunction,
): FetchFunction {
	const base: FetchFunction = inner ?? ((input, init) => globalThis.fetch(input, init));
	return async (input, init) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		if (!url.pathname.endsWith("/v1/messages") || (init?.method ?? "GET").toUpperCase() !== "POST") {
			return base(input, init);
		}
		if (typeof init?.body !== "string") throw new Error("Claude on Vertex AI: unexpected request body");
		const body = JSON.parse(init.body) as Record<string, unknown>;
		const modelId = body.model;
		if (typeof modelId !== "string") throw new Error("Claude on Vertex AI: request has no model");
		delete body.model;
		body.anthropic_version ??= VERTEX_ANTHROPIC_VERSION;
		const headers = new Headers(init.headers);
		headers.delete("x-api-key");
		headers.delete("anthropic-version");
		headers.set("authorization", `Bearer ${await getVertexToken(env)}`);
		return base(vertexEndpoint(target, modelId, body.stream === true), {
			...init,
			headers,
			body: JSON.stringify(body),
		});
	};
}

function vertexOptions<T extends { env?: ProviderEnv; fetch?: FetchFunction; apiKey?: string }>(
	options: T | undefined,
): T {
	const env = options?.env;
	const target = resolveVertexTarget(env);
	return {
		...(options as T),
		apiKey: VERTEX_KEY_PLACEHOLDER,
		fetch: vertexFetch(target, env, options?.fetch),
	};
}

export const stream: StreamFunction<"anthropic-messages", AnthropicOptions> = (model, context, options) =>
	anthropicStream(model as Model<"anthropic-messages">, context, vertexOptions(options));

export const streamSimple: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (model, context, options) =>
	anthropicStreamSimple(model as Model<"anthropic-messages">, context, vertexOptions(options));
