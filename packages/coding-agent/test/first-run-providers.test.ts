import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinProviders } from "@veyraco/fingers-ai/providers/all";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	detectLocalCredentials,
	FIRST_RUN_PROVIDERS,
	parseAwsProfiles,
	saveOpenAICompatibleEndpoint,
} from "../src/core/first-run-providers.ts";
import { openCredentialStorage } from "../src/core/keychain-auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemorySecretStore } from "../src/core/os-keychain.ts";

describe("first-run providers", () => {
	let home: string;

	beforeEach(() => {
		home = join(tmpdir(), `fingers-first-run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(home, { recursive: true });
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	test("the screen lists the canvas providers in order, each backed by a built-in provider", () => {
		expect(FIRST_RUN_PROVIDERS.map((choice) => choice.label)).toEqual([
			"Anthropic API",
			"Amazon Bedrock",
			"Google Vertex AI",
			"OpenAI",
			"Google Gemini",
			"OpenRouter",
			"Moonshot Kimi",
			"xAI Grok",
			"DeepSeek",
			"Qwen",
			"Any OpenAI-compatible endpoint",
		]);
		const builtin = new Set(builtinProviders().map((provider) => provider.id));
		for (const choice of FIRST_RUN_PROVIDERS) {
			for (const id of choice.providerIds) expect(builtin.has(id), `${choice.label}: ${id}`).toBe(true);
		}
	});

	test("finds environment keys and an AWS profile without reading secret values", () => {
		mkdirSync(join(home, ".aws"));
		writeFileSync(
			join(home, ".aws", "config"),
			"[default]\nregion = us-east-1\n\n[profile dev]\nregion = eu-central-1\n",
		);
		writeFileSync(join(home, ".aws", "credentials"), "[default]\naws_access_key_id = AKIDSECRET\n");
		const found = detectLocalCredentials({
			home,
			env: { ANTHROPIC_API_KEY: "sk-ant-secret", OPENAI_API_KEY: "sk-openai-secret", XAI_API_KEY: " " },
		});
		expect(found).toEqual([
			{ label: "Anthropic API", providerId: "anthropic", source: "ANTHROPIC_API_KEY" },
			{ label: "OpenAI", providerId: "openai", source: "OPENAI_API_KEY" },
			{ label: "Amazon Bedrock", providerId: "amazon-bedrock", source: '~/.aws profile "dev"' },
		]);
		expect(JSON.stringify(found)).not.toMatch(/secret|AKID/);
	});

	test("prefers the AWS_PROFILE in use and finds Vertex application default credentials", () => {
		mkdirSync(join(home, ".aws"));
		writeFileSync(join(home, ".aws", "credentials"), "[default]\n[work]\n[dev]\n");
		mkdirSync(join(home, ".config", "gcloud"), { recursive: true });
		writeFileSync(join(home, ".config", "gcloud", "application_default_credentials.json"), "{}");
		const found = detectLocalCredentials({ home, env: { AWS_PROFILE: "work", GOOGLE_CLOUD_PROJECT: "veyra-dev" } });
		expect(found).toEqual([
			{ label: "Amazon Bedrock", providerId: "amazon-bedrock", source: '~/.aws profile "work"' },
			{
				label: "Google Vertex AI",
				providerId: "google-vertex-anthropic",
				source: "gcloud application default credentials",
			},
		]);
		expect(detectLocalCredentials({ home: join(home, "empty"), env: {} })).toEqual([]);
	});

	test("parses AWS config and credentials sections", () => {
		expect(parseAwsProfiles("[default]\n[profile a]\n[sso-session x]\n", "config")).toEqual(["default", "a"]);
		expect(parseAwsProfiles("﻿[default]\r\n[b]\r\n", "credentials")).toEqual(["default", "b"]);
	});

	test("an OpenAI-compatible endpoint is saved to models.json with its key in the keychain", async () => {
		const agentDir = join(home, "agent");
		const authPath = join(agentDir, "auth.json");
		const modelsPath = join(agentDir, "models.json");
		const store = new InMemorySecretStore();
		const { storage } = openCredentialStorage({
			authPath,
			env: { FINGERS_CREDENTIAL_STORE: "keychain" },
			secretStore: store,
		});
		await saveOpenAICompatibleEndpoint(
			{
				id: "my-endpoint",
				baseUrl: "https://llm.internal.example/v1/",
				models: ["local-coder"],
				apiKey: "endpoint-secret",
			},
			{ modelsPath, credentials: storage },
		);

		expect(JSON.parse(readFileSync(modelsPath, "utf-8"))).toEqual({
			providers: {
				"my-endpoint": {
					baseUrl: "https://llm.internal.example/v1",
					api: "openai-completions",
					models: [{ id: "local-coder" }],
				},
			},
		});
		for (const entry of readdirSync(agentDir)) {
			expect(readFileSync(join(agentDir, entry), "utf-8")).not.toContain("endpoint-secret");
		}
		expect(existsSync(authPath)).toBe(false);

		const runtime = await ModelRuntime.create({ credentials: storage, modelsPath, refreshOnCreate: false });
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getModel("my-endpoint", "local-coder")).toMatchObject({
			baseUrl: "https://llm.internal.example/v1",
		});
		expect((await runtime.getAuth("my-endpoint"))?.auth.apiKey).toBe("endpoint-secret");
	});

	test("an endpoint must be https (http only on localhost) and name a model", async () => {
		const options = {
			modelsPath: join(home, "models.json"),
			credentials: openCredentialStorage({ authPath: join(home, "auth.json") }).storage,
		};
		await expect(
			saveOpenAICompatibleEndpoint({ id: "x", baseUrl: "http://llm.example.com/v1", models: ["m"] }, options),
		).rejects.toThrow(/https/);
		await expect(
			saveOpenAICompatibleEndpoint({ id: "x", baseUrl: "http://localhost:11434/v1", models: [] }, options),
		).rejects.toThrow(/at least one model/);
		await expect(
			saveOpenAICompatibleEndpoint({ id: "Bad Name", baseUrl: "https://a.b/v1", models: ["m"] }, options),
		).rejects.toThrow(/Endpoint name/);
		await saveOpenAICompatibleEndpoint(
			{ id: "ollama", baseUrl: "http://localhost:11434/v1", models: ["qwen3"] },
			options,
		);
		expect(existsSync(options.modelsPath)).toBe(true);
	});
});
