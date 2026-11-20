import type { Model, OpenAICompletionsCompat } from "../../src/types.ts";
import { defineProvider, modelsDevModels } from "../define.ts";
import { getEffortThinkingLevelMap } from "../reasoning.ts";

// Qwen pay-as-you-go API keys from Alibaba Cloud Model Studio (international, Singapore), OpenAI-compatible
// mode. models.dev lists them as "alibaba". The Token Plan subscriptions are separate providers.
// https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope
export const QWEN_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

const COMPAT: OpenAICompletionsCompat = {
	thinkingFormat: "qwen",
	supportsStore: false,
	supportsReasoningEffort: false,
	supportsStrictMode: true,
};

export default defineProvider({
	id: "qwen",
	models: (ctx) =>
		modelsDevModels(ctx, "alibaba", {
			api: "openai-completions",
			baseUrl: QWEN_BASE_URL,
			recordReasoning: false,
			skipDeprecated: true,
			// Qwen's own text models; the other vendors Model Studio resells have their own providers.
			include: (source) =>
				source.id.startsWith("qwen") && !/(?:-vl|-omni|-mt|-ocr|-asr|-tts|livetranslate|-image)/.test(source.id),
			map: (model, source): Model<"openai-completions"> => {
				const thinkingLevelMap = getEffortThinkingLevelMap(source.reasoningOptions ?? []);
				return {
					...model,
					compat: thinkingLevelMap ? { ...COMPAT, supportsReasoningEffort: true } : { ...COMPAT },
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				};
			},
		}),
});
