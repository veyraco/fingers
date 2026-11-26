import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelsDevV2Model } from "../catalog/sources/models-dev.ts";
import { getModel } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import type { Api, Model } from "../src/types.ts";
import { writeUpstreamMock } from "./catalog-generation-utils.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];
const originalTogetherApiKey = process.env.TOGETHER_API_KEY;

/** Generate the Together catalog from the given models.dev entries instead of the live catalog. */
function generateTogetherModels(models: ModelsDevV2Model[]): Record<string, Model<Api>> {
	const root = mkdtempSync(join(tmpdir(), "fingers-together-generation-"));
	temporaryRoots.push(root);
	const preloadPath = join(root, "mock-catalog.mjs");
	const outputPath = join(root, "catalog");
	writeUpstreamMock(preloadPath, {
		togetherai: { models: Object.fromEntries(models.map((model) => [model.id, model])) },
	});
	const result = spawnSync(
		process.execPath,
		["--import", pathToFileURL(preloadPath).href, "catalog/generate.ts", "--json-only", "--json-output", outputPath],
		{ cwd: packageRoot, encoding: "utf8", timeout: 10_000 },
	);
	expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
	return JSON.parse(readFileSync(join(outputPath, "providers/together.json"), "utf8")) as Record<string, Model<Api>>;
}

function reasoningModel(id: string, reasoning: ModelsDevV2Model["capabilities"]["reasoning"]): ModelsDevV2Model {
	return {
		id,
		type: "chat",
		name: id,
		modalities: { input: ["text"], output: ["text"] },
		capabilities: { tools: { supported: true }, reasoning },
		api: {},
	};
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
	if (originalTogetherApiKey === undefined) {
		delete process.env.TOGETHER_API_KEY;
	} else {
		process.env.TOGETHER_API_KEY = originalTogetherApiKey;
	}
});

describe("Together models", () => {
	it("registers the default Kimi K3 model via OpenAI-compatible Chat Completions API", () => {
		const model = getModel("together", "moonshotai/Kimi-K3");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("together");
		expect(model.baseUrl).toBe("https://api.together.ai/v1");
		expect(model.reasoning).toBe(true);
		expect(model.thinkingLevelMap).toEqual({ minimal: null, low: null, medium: null });
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(1048576);
		expect(model.maxTokens).toBe(1048576);
		expect(model.cost).toEqual({
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 0,
		});
		expect(model.compat).toEqual({
			supportsStore: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "together",
			supportsStrictMode: false,
			supportsLongCacheRetention: false,
		});
	});

	// models.dev lists both models as deprecated (seen 2026-11-26), so the live catalog no longer
	// carries them; their reasoning corrections stay covered against a fixture.
	it("models Together reasoning controls from the Together API surface", () => {
		const models = generateTogetherModels([
			reasoningModel("openai/gpt-oss-120b", { supported: true, effort: ["low", "medium", "high"] }),
			reasoningModel("deepseek-ai/DeepSeek-V4-Pro-0813", { supported: true, toggle: true }),
		]);
		const gptOss = models["openai/gpt-oss-120b"];
		expect(gptOss.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			max: null,
			xhigh: null,
		});
		expect(gptOss.compat).toMatchObject({
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
		});

		const deepSeekV4 = models["deepseek-ai/DeepSeek-V4-Pro-0813"];
		expect(deepSeekV4.thinkingLevelMap).toEqual({
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
		});
		expect(deepSeekV4.compat).toMatchObject({
			supportsReasoningEffort: true,
			thinkingFormat: "together",
		});
	});

	it("resolves TOGETHER_API_KEY from the environment", () => {
		process.env.TOGETHER_API_KEY = "test-together-key";

		expect(findEnvKeys("together")).toEqual(["TOGETHER_API_KEY"]);
		expect(getEnvApiKey("together")).toBe("test-together-key");
	});
});
