/**
 * Google access tokens for Claude on Vertex AI, from Application Default Credentials.
 *
 * google-auth-library is Node only, so it is imported through a variable specifier that bundlers
 * (browser smoke, Bun compile) cannot follow. The Bun binary registers a statically imported token source
 * instead (`@veyraco/fingers-ai/vertex-auth-provider`), like the bedrock provider module.
 */

import type { ProviderEnv } from "../types.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

/** Supplies a Google access token. Tests inject one; the default uses Application Default Credentials. */
export type VertexTokenSource = (env?: ProviderEnv) => Promise<string>;

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

interface GoogleAuthLike {
	getAccessToken(): Promise<string | null | undefined>;
}
export type GoogleAuthConstructor = new (options: { scopes: string[]; keyFilename?: string }) => GoogleAuthLike;

/** A token source over a GoogleAuth class; one client per credentials file. */
export function createGoogleAdcTokenSource(load: () => Promise<GoogleAuthConstructor>): VertexTokenSource {
	const clients = new Map<string, Promise<GoogleAuthLike>>();
	return async (env) => {
		const keyFilename = getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env);
		const cacheKey = keyFilename ?? "";
		let client = clients.get(cacheKey);
		if (!client) {
			client = load().then(
				(GoogleAuth) => new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE], ...(keyFilename ? { keyFilename } : {}) }),
			);
			clients.set(cacheKey, client);
		}
		const token = await (await client).getAccessToken();
		if (!token) throw new Error("Google Application Default Credentials returned no access token");
		return token;
	};
}

const GOOGLE_AUTH_SPECIFIER = "google-auth-" + "library";

const defaultTokenSource = createGoogleAdcTokenSource(
	async () => ((await import(GOOGLE_AUTH_SPECIFIER)) as { GoogleAuth: GoogleAuthConstructor }).GoogleAuth,
);

let tokenSource: VertexTokenSource = defaultTokenSource;

/** Replace the token source (the Bun binary, tests). Returns the previous one. */
export function setVertexTokenSource(source: VertexTokenSource): VertexTokenSource {
	const previous = tokenSource;
	tokenSource = source;
	return previous;
}

export function getVertexToken(env?: ProviderEnv): Promise<string> {
	return tokenSource(env);
}
