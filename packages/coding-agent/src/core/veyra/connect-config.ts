/**
 * Which Veyra Connect `fingers login` signs in to, and where the Veyra apps' APIs are.
 *
 * Connect is the OIDC issuer (`https://connect.veyra.so`, locally `https://connect.veyra.localhost`). Programs call
 * the apps at one API domain, `https://api.veyra.so/<app>/v1` (locally `https://api.veyra.localhost/<app>/v1`).
 * `--connect <url>` or FINGERS_CONNECT_URL picks another Connect; FINGERS_API_URL another API origin.
 */

export const DEFAULT_CONNECT_URL = "https://connect.veyra.so";
export const LOCAL_CONNECT_URL = "https://connect.veyra.localhost";

/** Connect's public OAuth client for Fingers (device flow only, tokens for `fingers`). */
export const FINGERS_CLIENT_ID = "fingers-cli";

/** The Veyra apps, as Connect names them in `aud` and in RFC 8707 `resource`. */
const VEYRA_APPS = ["connect", "intelligence", "hands", "brain", "eyes", "fingers"] as const;
export type VeyraApp = (typeof VEYRA_APPS)[number];

/** The app the device flow's own access token is for. Other audiences come from the refresh grant with `resource`. */
export const FINGERS_APP: VeyraApp = "fingers";

/** What the device flow asks for: who the person is, and a refresh token. */
export const FINGERS_SCOPE = "openid profile email offline_access";

export class ConnectConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConnectConfigError";
	}
}

/**
 * A Connect address as an issuer string: https (http only on a loopback address, for a Connect on this computer),
 * no credentials, query or fragment, no trailing slash.
 */
function normalizeConnectUrl(value: string): string {
	const trimmed = value.trim();
	if (!URL.canParse(trimmed)) throw new ConnectConfigError(`"${trimmed}" is not a Connect address (https://…)`);
	const url = new URL(trimmed);
	const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new ConnectConfigError(`Connect must be reached over https: ${url.origin}`);
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new ConnectConfigError("A Connect address takes no user name, password, query or fragment");
	}
	const path = url.pathname.replace(/\/+$/, "");
	return `${url.origin}${path}`;
}

/** The Connect to sign in to: `--connect`, else FINGERS_CONNECT_URL, else connect.veyra.so. */
export function resolveConnectUrl(options: { flag?: string; env?: NodeJS.ProcessEnv } = {}): string {
	const env = options.env ?? process.env;
	const value = options.flag ?? env.FINGERS_CONNECT_URL?.trim();
	return normalizeConnectUrl(value || DEFAULT_CONNECT_URL);
}

/**
 * The API origin for a Connect: FINGERS_API_URL when set; `connect.<domain>` pairs with `api.<domain>`
 * (connect.veyra.so → api.veyra.so); any other Connect (one on this computer) serves the apps' paths itself.
 */
export function resolveApiUrl(issuer: string, env: NodeJS.ProcessEnv = process.env): string {
	const override = env.FINGERS_API_URL?.trim();
	if (override) return normalizeConnectUrl(override);
	const url = new URL(issuer);
	if (url.hostname.startsWith("connect.")) {
		return `${url.protocol}//api.${url.hostname.slice("connect.".length)}${url.port ? `:${url.port}` : ""}`;
	}
	return url.origin;
}

/** The base URL of an app's public API, e.g. `https://api.veyra.so/brain/v1`. */
export function veyraApiBaseUrl(apiUrl: string, app: VeyraApp): string {
	return `${apiUrl.replace(/\/+$/, "")}/${app}/v1`;
}

/** Where a person removes a device's access in Connect (Connected apps). */
export function connectedAppsUrl(issuer: string): string {
	return `${issuer}/account/apps`;
}
