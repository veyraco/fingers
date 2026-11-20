import type { Model } from "../../src/types.ts";
import { defineProvider, mergeCompat, mergeThinking, withInputLimits } from "../define.ts";
import {
	claude55ThinkingLevels,
	enableClaudeMidConvoEffort,
	supportsClaudeMidConvoEffort,
	supportsClaudeMidConvoSystemMessages,
} from "../families/anthropic.ts";
import { modelsDevChatModels } from "../sources/models-dev.ts";

// Claude on Google Vertex AI, through the Anthropic Messages API on Vertex's rawPredict endpoints
// (src/api/anthropic-vertex.ts). Model ids, limits and list prices are Anthropic's own: Vertex bills the
// same per-token prices on the global endpoint. Which Claude models Vertex serves comes from models.dev,
// which lists them as `claude-x@YYYYMMDD` or `claude-x@default`.
// https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude
const MODELS_55 = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);

/** `claude-opus-4-5@20251101` -> `claude-opus-4-5-20251101`, `claude-sonnet-4-6@default` -> `claude-sonnet-4-6`. */
export function anthropicIdFromVertex(vertexId: string): string {
	return vertexId.replace(/@default$/, "").replace(/@(\d{8})$/, "-$1");
}

export default defineProvider({
	id: "google-vertex-anthropic",
	models: (ctx) => {
		const onVertex = new Set(
			modelsDevChatModels(ctx.sources.modelsDev, "google-vertex")
				.filter((model) => model.id.startsWith("claude-"))
				.map((model) => anthropicIdFromVertex(model.id)),
		);
		return ctx
			.providerModels("anthropic")
			.filter((model) => onVertex.has(model.id) || onVertex.has(model.id.replace(/-\d{8}$/, "")))
			.map((model) => {
				const vertexModel = {
					...model,
					provider: "google-vertex-anthropic",
					baseUrl: "https://{location}-aiplatform.googleapis.com",
				} as Model<"anthropic-messages">;
				if (MODELS_55.has(model.id)) mergeThinking(vertexModel, claude55ThinkingLevels(model.id));
				return vertexModel;
			});
	},
	finalize: (model) => {
		if (model.api !== "anthropic-messages") return;
		const messagesModel = model as Model<"anthropic-messages">;
		if (supportsClaudeMidConvoEffort(model.id)) enableClaudeMidConvoEffort(messagesModel);
		if (supportsClaudeMidConvoSystemMessages(model.id)) {
			mergeCompat(messagesModel, { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true });
		}
		// Vertex caches prompts like the Anthropic API (5 minutes; 1 hour with ttl).
		model.promptCache = { short: 300, long: 3600 };
		withInputLimits(model, {
			maxRequestBytes: 30 * 1024 * 1024,
			images: { maxPerRequest: model.contextWindow === 200000 ? 100 : 600 },
		});
	},
});
