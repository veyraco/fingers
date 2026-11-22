/**
 * The Veyra account in Fingers (`fingers login`): Connect's device flow, tokens per audience in the OS keychain,
 * sign out with revocation. See veyra-auth.ts.
 */
import { hostname } from "node:os";
import { join } from "node:path";
import { VERSION } from "../../config.ts";
import { resolveApiUrl, resolveConnectUrl } from "./connect-config.ts";
import { openVeyraSessionVault } from "./session-vault.ts";
import { VeyraAuth } from "./veyra-auth.ts";
import { createVeyraLog } from "./veyra-log.ts";

export {
	ConnectConfigError,
	connectedAppsUrl,
	DEFAULT_CONNECT_URL,
	FINGERS_CLIENT_ID,
	LOCAL_CONNECT_URL,
	resolveApiUrl,
	resolveConnectUrl,
	type VeyraApp,
	veyraApiBaseUrl,
} from "./connect-config.ts";
export { type DeviceCodePrompt, DeviceFlowError } from "./device-flow.ts";
export { ConnectUnavailableError, VeyraApiError } from "./oidc-client.ts";
export type { VeyraAccount, VeyraStorageInfo } from "./session-vault.ts";
export {
	VeyraAudienceError,
	VeyraAuth,
	type VeyraLogoutResult,
	type VeyraOrganization,
	VeyraSignedOutError,
} from "./veyra-auth.ts";

/**
 * The Veyra sign-in of this computer for the Connect that `connectUrl`, FINGERS_CONNECT_URL or the default names,
 * logging to `veyra.log` in the agent directory.
 */
export function createVeyraAuth(options: {
	agentDir: string;
	connectUrl?: string;
	env?: NodeJS.ProcessEnv;
}): VeyraAuth {
	const env = options.env ?? process.env;
	const issuer = resolveConnectUrl({ flag: options.connectUrl, env });
	const level = env.FINGERS_LOG_LEVEL;
	return new VeyraAuth({
		issuer,
		vault: openVeyraSessionVault({ agentDir: options.agentDir, issuer, env }),
		apiUrl: resolveApiUrl(issuer, env),
		appVersion: VERSION,
		deviceName: hostname().slice(0, 64),
		// Connect shows the computer's OS on its confirm page from this.
		userAgent: `fingers/${VERSION} (${process.platform})`,
		log: createVeyraLog({
			path: join(options.agentDir, "veyra.log"),
			version: VERSION,
			env: env.FINGERS_ENV ?? env.VEYRA_ENV ?? "local",
			level: level === "debug" || level === "warn" || level === "error" ? level : "info",
		}),
	});
}
