/**
 * The providers the first-run screen offers (canvas "Fingers · CLI & web", FingersTuiFirstRun option 2),
 * what this machine already has for them (option 3, "Found on this machine"), and saving an
 * OpenAI-compatible endpoint whose key goes to the credential store (OS keychain), never models.json.
 *
 * Detection reads only names: environment variable presence, AWS profile names and whether the gcloud
 * application-default credentials file exists. It never reads or returns a secret value.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CredentialStore } from "@veyraco/fingers-ai";
import { stripBom } from "../utils/text.ts";

export interface FirstRunProvider {
	/** Label on the first-run screen. */
	label: string;
	/** Built-in provider ids this choice configures; empty for a custom endpoint. */
	providerIds: readonly string[];
	/** Environment variables that configure it (option 3). */
	envVars: readonly string[];
	/** How the key is given in option 2. */
	setup: "api_key" | "aws" | "gcloud" | "custom_endpoint";
}

/** In screen order. */
export const FIRST_RUN_PROVIDERS: readonly FirstRunProvider[] = [
	{ label: "Anthropic API", providerIds: ["anthropic"], envVars: ["ANTHROPIC_API_KEY"], setup: "api_key" },
	{
		label: "Amazon Bedrock",
		providerIds: ["amazon-bedrock"],
		envVars: ["AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_PROFILE"],
		setup: "aws",
	},
	{
		label: "Google Vertex AI",
		providerIds: ["google-vertex-anthropic", "google-vertex"],
		envVars: ["GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS"],
		setup: "gcloud",
	},
	{ label: "OpenAI", providerIds: ["openai"], envVars: ["OPENAI_API_KEY"], setup: "api_key" },
	{ label: "Google Gemini", providerIds: ["google"], envVars: ["GEMINI_API_KEY"], setup: "api_key" },
	{ label: "OpenRouter", providerIds: ["openrouter"], envVars: ["OPENROUTER_API_KEY"], setup: "api_key" },
	{ label: "Moonshot Kimi", providerIds: ["moonshotai"], envVars: ["MOONSHOT_API_KEY"], setup: "api_key" },
	{ label: "xAI Grok", providerIds: ["xai"], envVars: ["XAI_API_KEY"], setup: "api_key" },
	{ label: "DeepSeek", providerIds: ["deepseek"], envVars: ["DEEPSEEK_API_KEY"], setup: "api_key" },
	{ label: "Qwen", providerIds: ["qwen"], envVars: ["DASHSCOPE_API_KEY"], setup: "api_key" },
	{ label: "Any OpenAI-compatible endpoint", providerIds: [], envVars: [], setup: "custom_endpoint" },
];

export interface DetectedCredential {
	/** First-run label, e.g. "Amazon Bedrock". */
	label: string;
	providerId: string;
	/** What was found, for the screen: `ANTHROPIC_API_KEY`, `~/.aws profile "dev"`, `gcloud application default credentials`. */
	source: string;
}

interface DetectOptions {
	env?: NodeJS.ProcessEnv;
	home?: string;
}

const SECTION_LINE = /^\s*\[\s*([^\]]+?)\s*\]\s*$/;

/** Profile names in an AWS config or credentials file (`[profile dev]` / `[dev]`). */
export function parseAwsProfiles(text: string, kind: "config" | "credentials"): string[] {
	const names: string[] = [];
	for (const line of stripBom(text).split(/\r?\n/)) {
		const match = line.match(SECTION_LINE);
		if (!match) continue;
		const section = match[1];
		if (kind === "credentials") {
			names.push(section);
		} else if (section === "default") {
			names.push("default");
		} else if (section.startsWith("profile ")) {
			names.push(section.slice("profile ".length).trim());
		}
	}
	return names;
}

function readIfExists(path: string): string | undefined {
	try {
		return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
	} catch {
		return undefined;
	}
}

function awsProfiles(env: NodeJS.ProcessEnv, home: string): string[] {
	const configPath = env.AWS_CONFIG_FILE || join(home, ".aws", "config");
	const credentialsPath = env.AWS_SHARED_CREDENTIALS_FILE || join(home, ".aws", "credentials");
	const names = new Set<string>();
	const config = readIfExists(configPath);
	if (config) for (const name of parseAwsProfiles(config, "config")) names.add(name);
	const credentials = readIfExists(credentialsPath);
	if (credentials) for (const name of parseAwsProfiles(credentials, "credentials")) names.add(name);
	return [...names];
}

/** What this machine already offers for the first-run providers. */
export function detectLocalCredentials(options: DetectOptions = {}): DetectedCredential[] {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const found: DetectedCredential[] = [];
	const has = (name: string) => !!env[name]?.trim();

	for (const choice of FIRST_RUN_PROVIDERS) {
		if (choice.setup !== "api_key") continue;
		const envVar = choice.envVars.find(has);
		if (envVar) found.push({ label: choice.label, providerId: choice.providerIds[0], source: envVar });
	}

	// Bedrock: a bearer token or access keys in the environment, else the AWS profile in use or the profiles on disk.
	if (has("AWS_BEARER_TOKEN_BEDROCK")) {
		found.push({ label: "Amazon Bedrock", providerId: "amazon-bedrock", source: "AWS_BEARER_TOKEN_BEDROCK" });
	} else if (has("AWS_ACCESS_KEY_ID") && has("AWS_SECRET_ACCESS_KEY")) {
		found.push({ label: "Amazon Bedrock", providerId: "amazon-bedrock", source: "AWS_ACCESS_KEY_ID" });
	} else {
		const profiles = awsProfiles(env, home);
		const selected = env.AWS_PROFILE?.trim();
		const profile =
			selected && profiles.includes(selected)
				? selected
				: (profiles.find((name) => name !== "default") ?? profiles[0]);
		if (profile) {
			found.push({ label: "Amazon Bedrock", providerId: "amazon-bedrock", source: `~/.aws profile "${profile}"` });
		}
	}

	// Vertex: application default credentials (or a service account file) and a project.
	const adcPath =
		env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ||
		join(home, ".config", "gcloud", "application_default_credentials.json");
	const project = env.ANTHROPIC_VERTEX_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT;
	if (existsSync(adcPath) && project?.trim()) {
		found.push({
			label: "Google Vertex AI",
			providerId: "google-vertex-anthropic",
			source: env.GOOGLE_APPLICATION_CREDENTIALS
				? "GOOGLE_APPLICATION_CREDENTIALS"
				: "gcloud application default credentials",
		});
	}
	return found;
}

interface OpenAICompatibleEndpoint {
	/** Provider id in models.json, e.g. "my-endpoint". */
	id: string;
	/** Base URL including the version path, e.g. https://llm.example.com/v1. */
	baseUrl: string;
	/** Model ids served by the endpoint. */
	models: readonly string[];
	/** API key; stored in the credential store under the provider id. */
	apiKey?: string;
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Add an OpenAI-compatible endpoint: the provider goes into models.json without its key, and the key goes
 * into the credential store (the OS keychain by default), where the runtime finds it for that provider.
 */
export async function saveOpenAICompatibleEndpoint(
	endpoint: OpenAICompatibleEndpoint,
	options: { modelsPath: string; credentials: CredentialStore },
): Promise<void> {
	if (!PROVIDER_ID.test(endpoint.id)) {
		throw new Error("Endpoint name: lower-case letters, digits and dashes, starting with a letter or digit");
	}
	let url: URL;
	try {
		url = new URL(endpoint.baseUrl);
	} catch {
		throw new Error(`Not a URL: ${endpoint.baseUrl}`);
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new Error("The endpoint must use https (http only on localhost)");
	}
	if (endpoint.models.length === 0) throw new Error("Name at least one model");

	const existingText = readIfExists(options.modelsPath);
	const config = existingText ? (JSON.parse(stripBom(existingText)) as { providers?: Record<string, unknown> }) : {};
	config.providers = {
		...config.providers,
		[endpoint.id]: {
			baseUrl: endpoint.baseUrl.replace(/\/+$/, ""),
			api: "openai-completions",
			models: endpoint.models.map((id) => ({ id })),
		},
	};
	if (endpoint.apiKey) {
		const key = endpoint.apiKey.trim();
		await options.credentials.modify(endpoint.id, async () => ({ type: "api_key", key }));
	}
	const dir = dirname(options.modelsPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(options.modelsPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
