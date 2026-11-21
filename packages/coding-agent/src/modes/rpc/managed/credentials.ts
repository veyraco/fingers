/**
 * How managed mode hands host-provided secrets to Fingers' model runtime and MCP extension without letting
 * Fingers' config-value syntax (`$VAR`, `${VAR}`, `!command`) reinterpret them.
 */
import type { McpServerConfig } from "../../../core/mcp-servers.ts";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import { type SecretSet, secretHeaderValues } from "./secrets.ts";

/** Escape a literal so config-value resolution returns it unchanged: `$` -> `$$`, a leading `!` -> `$!`. */
export function escapeConfigValue(value: string): string {
	const escaped = value.split("$").join("$$");
	return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

function escapeHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers || Object.keys(headers).length === 0) return undefined;
	return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, escapeConfigValue(value)]));
}

export interface ManagedMcpServer {
	name: string;
	url: string;
	headers?: Record<string, string>;
	allowed_tools?: string[];
	approval?: "never" | "write_tools" | "always";
}

/** `configure.mcp_servers` as registrations for the MCP extension: tools declared directly, allow-listed. */
export function mcpServerEntries(
	servers: readonly ManagedMcpServer[],
): Array<{ name: string; config: McpServerConfig }> {
	return servers.map((server) => {
		const headers = escapeHeaders(server.headers);
		const allowed = server.allowed_tools;
		const config: McpServerConfig = {
			url: server.url,
			...(headers ? { headers } : {}),
			exposure: allowed ? "hidden" : "direct",
			...(allowed ? { toolExposure: Object.fromEntries(allowed.map((name) => [name, "direct" as const])) } : {}),
		};
		return { name: server.name, config };
	});
}

export interface CredentialsMessage {
	provider: string;
	base_url: string;
	credential_kind: "proxy_token" | "api_key" | "oauth_access_token";
	credential: string;
	expires_at?: string;
	headers?: Record<string, string>;
}

/**
 * Point the provider at `base_url` and give it the credential, in memory only: the key goes into the runtime
 * credential overlay (never auth.json), the base URL and extra headers into a runtime provider registration.
 */
export async function applyCredentials(
	modelRuntime: ModelRuntime,
	message: CredentialsMessage,
	secrets: SecretSet,
): Promise<void> {
	secrets.add(message.credential);
	for (const value of secretHeaderValues(message.headers)) secrets.add(value);
	const headers = escapeHeaders(message.headers);
	modelRuntime.registerProvider(message.provider, { baseUrl: message.base_url, ...(headers ? { headers } : {}) });
	await modelRuntime.setRuntimeApiKey(message.provider, message.credential);
}
