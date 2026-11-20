import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { QWEN_MODELS } from "./qwen.models.ts";

/** Qwen pay-as-you-go API keys (Alibaba Cloud Model Studio, international). */
export function qwenProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "qwen",
		name: "Qwen (Alibaba Cloud Model Studio)",
		baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		auth: { apiKey: envApiKeyAuth("Qwen API key (Model Studio)", ["DASHSCOPE_API_KEY"]) },
		models: Object.values(QWEN_MODELS),
		api: openAICompletionsApi(),
	});
}
