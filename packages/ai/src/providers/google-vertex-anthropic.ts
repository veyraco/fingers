import { anthropicVertexApi } from "../api/anthropic-vertex.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { GOOGLE_VERTEX_ANTHROPIC_MODELS } from "./google-vertex-anthropic.models.ts";

const VERTEX_ADC_PATH = "~/.config/gcloud/application_default_credentials.json";

/**
 * Claude on Vertex uses Application Default Credentials (`gcloud auth application-default login`, a
 * service account file, or the metadata server) plus a project. The location defaults to "global".
 */
const vertexAnthropicAuth: ApiKeyAuth = {
	name: "Google Cloud credentials",
	login: async (interaction) => {
		interaction.signal.throwIfAborted();
		interaction.notify({
			type: "info",
			message:
				"Claude on Vertex AI uses Application Default Credentials. Run `gcloud auth application-default login`, or give a service account file, then the project and location.",
			links: [
				{
					label: "Claude on Vertex AI",
					url: "https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude",
				},
			],
		});
		const project = await interaction.prompt({ type: "text", message: "Enter Google Cloud project ID" });
		const location = await interaction.prompt({
			type: "text",
			message: "Enter location (global, us-east5, europe-west1, ...)",
		});
		const credentialsPath = await interaction.prompt({
			type: "text",
			message: "Service account credentials file (empty: application default credentials)",
		});
		return {
			type: "api_key",
			env: {
				GOOGLE_CLOUD_PROJECT: project,
				GOOGLE_CLOUD_LOCATION: location || "global",
				...(credentialsPath ? { GOOGLE_APPLICATION_CREDENTIALS: credentialsPath } : {}),
			},
		};
	},
	resolve: async ({ ctx, credential, signal }) => {
		const env = async (name: string) => {
			signal.throwIfAborted();
			const value = await ctx.env(name);
			signal.throwIfAborted();
			return value;
		};
		const adcPath = credential?.env?.GOOGLE_APPLICATION_CREDENTIALS ?? (await env("GOOGLE_APPLICATION_CREDENTIALS"));
		const hasCredentials = await ctx.fileExists(adcPath ?? VERTEX_ADC_PATH);
		signal.throwIfAborted();
		const project =
			credential?.env?.GOOGLE_CLOUD_PROJECT ??
			(await env("ANTHROPIC_VERTEX_PROJECT_ID")) ??
			(await env("GOOGLE_CLOUD_PROJECT")) ??
			(await env("GCLOUD_PROJECT"));
		if (!hasCredentials || !project) return undefined;
		const location =
			credential?.env?.GOOGLE_CLOUD_LOCATION ??
			(await env("CLOUD_ML_REGION")) ??
			(await env("GOOGLE_CLOUD_LOCATION"));
		return {
			auth: {},
			env: {
				...credential?.env,
				GOOGLE_CLOUD_PROJECT: project,
				...(location ? { GOOGLE_CLOUD_LOCATION: location } : {}),
				...(adcPath ? { GOOGLE_APPLICATION_CREDENTIALS: adcPath } : {}),
			},
			source: credential ? "stored credential" : "gcloud application default credentials",
		};
	},
};

export function googleVertexAnthropicProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "google-vertex-anthropic",
		name: "Claude on Google Vertex AI",
		auth: { apiKey: vertexAnthropicAuth },
		models: Object.values(GOOGLE_VERTEX_ANTHROPIC_MODELS),
		api: anthropicVertexApi(),
	});
}
