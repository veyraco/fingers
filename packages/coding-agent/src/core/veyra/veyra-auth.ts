/**
 * The Veyra account in Fingers: sign in with the device flow (`fingers login`, `/login`), access tokens per audience,
 * who is signed in (`fingers whoami`, `/org`, the status line), and sign out (`fingers logout`, `/logout`).
 *
 * - The device flow's token is for `fingers`. Tokens for other apps (connect, brain, eyes) come from the refresh grant
 *   with RFC 8707 `resource`; Connect rotates the refresh token every time, and the new one replaces the old in the
 *   keychain under the vault's lock.
 * - Access tokens are cached until a minute before they expire (Connect issues them for 5 minutes).
 * - A refresh token Connect no longer takes (`invalid_grant`: signed out in Connect, member removed, app off) ends the
 *   sign-in here too.
 * - Sign out revokes the refresh token at Connect (RFC 7009) and deletes the sign-in from the keychain, even when
 *   Connect can't be reached.
 *
 * Callers: F12 (ee gate: `organization()` for tier and apps), F13 (model connections: `getAccessToken("connect")`),
 * Brain and Eyes features (`getAccessToken("brain" | "eyes")`, `apiBaseUrl(app)`).
 */
import type { TraceContext } from "../../modes/rpc/managed/trace.ts";
import { FINGERS_APP, FINGERS_CLIENT_ID, resolveApiUrl, type VeyraApp, veyraApiBaseUrl } from "./connect-config.ts";
import { type DeviceCodePrompt, DeviceFlowError, runDeviceFlow, type Sleep } from "./device-flow.ts";
import { ConnectOidcClient, newVeyraTrace, OAuthResponseError, type TokenSet } from "./oidc-client.ts";
import {
	type StoredAccessToken,
	type StoredVeyraSession,
	type VeyraAccount,
	type VeyraSessionVault,
	type VeyraStorageInfo,
	veyraSessionAccount,
} from "./session-vault.ts";
import { silentVeyraLog, type VeyraLog } from "./veyra-log.ts";

/** Not signed in, or Connect ended the sign-in. */
export class VeyraSignedOutError extends Error {
	readonly reason: "not_signed_in" | "session_ended";

	constructor(reason: "not_signed_in" | "session_ended") {
		super(
			reason === "not_signed_in"
				? "Not signed in to Veyra. Run fingers login."
				: "Your Veyra sign-in has ended. Run fingers login again.",
		);
		this.name = "VeyraSignedOutError";
		this.reason = reason;
	}
}

/** Connect gives this sign-in no token for an app (not one of the client's resources, or the app is off). */
export class VeyraAudienceError extends Error {
	readonly audience: VeyraApp;

	constructor(audience: VeyraApp, detail: string | undefined) {
		super(`Connect gives Fingers no ${audience} token${detail ? `: ${detail}` : ""}`);
		this.name = "VeyraAudienceError";
		this.audience = audience;
	}
}

export interface VeyraOrganization {
	id: string;
	code?: string;
	name: string;
	tier?: string;
	appsEnabled: string[];
	/** The signed-in member's group. */
	groupName?: string;
}

export type VeyraRevocation = "revoked" | "unsupported" | "failed" | "none";

export interface VeyraLogoutResult {
	/** There was a sign-in to end. */
	signedIn: boolean;
	revocation: VeyraRevocation;
	/** Why the revocation failed. */
	detail?: string;
}

export interface VeyraAuthOptions {
	issuer: string;
	vault: VeyraSessionVault;
	appVersion: string;
	clientId?: string;
	/** Origin of the apps' APIs (`https://api.veyra.so`). Default: derived from the issuer. */
	apiUrl?: string;
	/** Shown on Connect's confirm page. */
	deviceName?: string;
	userAgent?: string;
	fetch?: typeof fetch;
	log?: VeyraLog;
	now?: () => number;
	sleep?: Sleep;
}

/** Refresh a token this long before it expires. */
const REFRESH_MARGIN_MS = 60_000;

function decodeJwtPayload(token: string | undefined): Record<string, unknown> {
	const part = token?.split(".")[1];
	if (!part) return {};
	try {
		const value = JSON.parse(Buffer.from(part, "base64url").toString("utf-8")) as unknown;
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function claim(claims: Record<string, unknown>, name: string): string | undefined {
	const value = claims[name];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class VeyraAuth {
	readonly issuer: string;
	readonly clientId: string;
	readonly apiUrl: string;
	private readonly vault: VeyraSessionVault;
	private readonly client: ConnectOidcClient;
	private readonly log: VeyraLog;
	private readonly now: () => number;
	private readonly sleep: Sleep | undefined;
	private readonly deviceName: string | undefined;
	private readonly appVersion: string;
	/** Access tokens this process already holds, so a valid one needs no keychain read. */
	private readonly cache = new Map<string, StoredAccessToken>();

	constructor(options: VeyraAuthOptions) {
		this.issuer = options.issuer;
		this.clientId = options.clientId ?? FINGERS_CLIENT_ID;
		this.apiUrl = options.apiUrl ?? resolveApiUrl(options.issuer);
		this.vault = options.vault;
		this.log = options.log ?? silentVeyraLog;
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep;
		this.deviceName = options.deviceName;
		this.appVersion = options.appVersion;
		this.client = new ConnectOidcClient(options.issuer, {
			fetch: options.fetch,
			userAgent: options.userAgent,
			log: this.log,
		});
	}

	get storage(): VeyraStorageInfo {
		return this.vault.storage;
	}

	/** The signed-in account, from the keychain, without any network request. */
	account(): VeyraAccount | undefined {
		const session = this.vault.read();
		return session ? veyraSessionAccount(session, this.vault.storage) : undefined;
	}

	/** Base URL of an app's public API for this sign-in, e.g. `https://api.veyra.so/brain/v1`. */
	apiBaseUrl(app: VeyraApp): string {
		return veyraApiBaseUrl(this.apiUrl, app);
	}

	/**
	 * Sign in with the device flow. `onCode` shows the code and opens the browser. A previous sign-in to the same
	 * Connect is replaced and its refresh token revoked.
	 */
	async login(options: { onCode: (prompt: DeviceCodePrompt) => void; signal: AbortSignal }): Promise<VeyraAccount> {
		const trace = newVeyraTrace();
		this.log.log("info", "sign-in started", { issuer: this.issuer, trace_id: trace.traceId, span_id: trace.spanId });
		let tokens: TokenSet;
		try {
			tokens = await runDeviceFlow({
				client: this.client,
				clientId: this.clientId,
				deviceName: this.deviceName,
				appVersion: this.appVersion,
				onCode: options.onCode,
				signal: options.signal,
				trace,
				now: this.now,
				sleep: this.sleep,
			});
		} catch (error) {
			const reason = error instanceof DeviceFlowError ? error.reason : "failed";
			this.log.log(reason === "failed" ? "warn" : "info", "sign-in ended without tokens", {
				reason,
				oauth_error: error instanceof DeviceFlowError ? error.oauthError : undefined,
				trace_id: trace.traceId,
				span_id: trace.spanId,
			});
			throw error;
		}

		const session = this.sessionFromTokens(tokens);
		// Stored even if the person cancels now: the tokens exist at Connect either way.
		const previous = await this.vault.update(async (current) => ({ result: current, next: session }));
		this.cache.clear();
		this.cache.set(FINGERS_APP, session.access[FINGERS_APP]!);
		this.log.log("info", "signed in", {
			org_id: session.org,
			actor: session.subject,
			persistent: this.vault.storage.persistent,
			trace_id: trace.traceId,
			span_id: trace.spanId,
		});
		if (previous?.refresh_token && previous.refresh_token !== session.refresh_token) {
			await this.revokeQuietly(previous.refresh_token, trace);
		}
		return veyraSessionAccount(session, this.vault.storage);
	}

	/**
	 * An access token for `audience`: cached while it has more than a minute left, else from the refresh grant
	 * (`resource=<audience>` for apps other than Fingers itself).
	 */
	async getAccessToken(audience: VeyraApp, options: { signal?: AbortSignal } = {}): Promise<string> {
		const cached = this.cache.get(audience);
		if (cached && cached.expires_at - this.now() > REFRESH_MARGIN_MS) return cached.token;
		const stored = this.vault.read()?.access[audience];
		if (stored && stored.expires_at - this.now() > REFRESH_MARGIN_MS) {
			this.cache.set(audience, stored);
			return stored.token;
		}

		const trace = newVeyraTrace();
		const outcome = await this.vault.update<
			{ kind: "token"; token: StoredAccessToken } | { kind: "signed_out"; reason: "not_signed_in" | "session_ended" }
		>(async (current) => {
			if (!current) return { result: { kind: "signed_out", reason: "not_signed_in" } };
			// Another process may have refreshed while this one waited for the lock.
			const fresh = current.access[audience];
			if (fresh && fresh.expires_at - this.now() > REFRESH_MARGIN_MS) {
				return { result: { kind: "token", token: fresh } };
			}
			if (!current.refresh_token) return { result: { kind: "signed_out", reason: "session_ended" }, next: null };
			let tokens: TokenSet;
			try {
				tokens = await this.client.refresh(
					{
						clientId: this.clientId,
						refreshToken: current.refresh_token,
						resource: audience === FINGERS_APP ? undefined : audience,
					},
					trace,
					options.signal,
				);
			} catch (error) {
				if (error instanceof OAuthResponseError && error.error === "invalid_grant") {
					this.log.log("warn", "sign-in ended by Connect", {
						audience,
						oauth_error: error.error,
						trace_id: trace.traceId,
						span_id: trace.spanId,
					});
					return { result: { kind: "signed_out", reason: "session_ended" }, next: null };
				}
				if (error instanceof OAuthResponseError && error.error === "invalid_target") {
					throw new VeyraAudienceError(audience, error.description);
				}
				throw error;
			}
			const token = { token: tokens.accessToken, expires_at: this.now() + tokens.expiresInSeconds * 1000 };
			const next: StoredVeyraSession = {
				...current,
				refresh_token: tokens.refreshToken ?? current.refresh_token,
				access: { ...this.unexpired(current.access), [audience]: token },
			};
			this.log.log("info", "access token refreshed", {
				audience,
				rotated: tokens.refreshToken !== undefined,
				trace_id: trace.traceId,
				span_id: trace.spanId,
			});
			return { result: { kind: "token", token }, next };
		}, options.signal);

		if (outcome.kind === "signed_out") {
			this.cache.clear();
			throw new VeyraSignedOutError(outcome.reason);
		}
		this.cache.set(audience, outcome.token);
		return outcome.token.token;
	}

	/** Sign out: revoke the refresh token at Connect (RFC 7009), then delete the sign-in from the keychain. */
	async logout(options: { signal?: AbortSignal } = {}): Promise<VeyraLogoutResult> {
		const trace = newVeyraTrace();
		const result = await this.vault.update<VeyraLogoutResult>(async (current) => {
			if (!current) return { result: { signedIn: false, revocation: "none" } };
			if (!current.refresh_token) return { result: { signedIn: true, revocation: "none" }, next: null };
			try {
				const revocation = await this.client.revoke(
					{ clientId: this.clientId, token: current.refresh_token, tokenTypeHint: "refresh_token" },
					trace,
					options.signal,
				);
				return { result: { signedIn: true, revocation }, next: null };
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return { result: { signedIn: true, revocation: "failed", detail }, next: null };
			}
		});
		this.cache.clear();
		if (result.signedIn) {
			this.log.log(result.revocation === "failed" ? "warn" : "info", "signed out", {
				revocation: result.revocation,
				reason: result.detail,
				trace_id: trace.traceId,
				span_id: trace.spanId,
			});
		}
		return result;
	}

	/** The signed-in organization from Connect's API (name, code, tier, apps on, the member's group). */
	async organization(options: { signal?: AbortSignal } = {}): Promise<VeyraOrganization> {
		const org = this.account()?.org;
		if (!org) throw new VeyraSignedOutError("not_signed_in");
		const token = await this.getAccessToken("connect", options);
		const body = await this.client.getJson(
			`${this.apiBaseUrl("connect")}/organizations/${encodeURIComponent(org)}`,
			token,
			newVeyraTrace(),
			options.signal,
		);
		const value = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
		const membership = (value.my_membership ?? {}) as Record<string, unknown>;
		const organization: VeyraOrganization = {
			id: claim(value, "id") ?? org,
			code: claim(value, "code"),
			name: claim(value, "name") ?? org,
			tier: claim(value, "tier"),
			appsEnabled: Array.isArray(value.apps_enabled)
				? value.apps_enabled.filter((app): app is string => typeof app === "string")
				: [],
			groupName: claim(membership, "group_name"),
		};
		await this.rememberOrganization(organization);
		return organization;
	}

	/** Keep the organization's name, tier and group with the sign-in, so they show without a request. */
	private async rememberOrganization(org: VeyraOrganization): Promise<void> {
		try {
			await this.vault.update(async (current) => {
				if (!current || current.org !== org.id) return { result: undefined };
				const facts = { org_name: org.name, org_code: org.code, tier: org.tier, group_name: org.groupName };
				const same = (Object.keys(facts) as Array<keyof typeof facts>).every((key) => current[key] === facts[key]);
				return same ? { result: undefined } : { result: undefined, next: { ...current, ...facts } };
			});
		} catch {
			// Only a display cache.
		}
	}

	private unexpired(access: Record<string, StoredAccessToken>): Record<string, StoredAccessToken> {
		const now = this.now();
		return Object.fromEntries(Object.entries(access).filter(([, token]) => token.expires_at > now));
	}

	private sessionFromTokens(tokens: TokenSet): StoredVeyraSession {
		const access = decodeJwtPayload(tokens.accessToken);
		let id = decodeJwtPayload(tokens.idToken);
		// The ID token comes straight from Connect's token endpoint over TLS (OIDC Core 3.1.3.7); its claims are only
		// shown, never trusted for access. One for another client or issuer is ignored.
		if (tokens.idToken && (claim(id, "iss") !== this.issuer || claim(id, "aud") !== this.clientId)) {
			this.log.log("warn", "id token ignored", { reason: "issuer or audience mismatch" });
			id = {};
		}
		return {
			v: 1,
			issuer: this.issuer,
			client_id: this.clientId,
			refresh_token: tokens.refreshToken,
			scope: tokens.scope,
			subject: claim(access, "sub") ?? claim(id, "sub") ?? "unknown",
			email: claim(id, "email"),
			name: claim(id, "name"),
			org: claim(access, "org") ?? claim(id, "org"),
			member: claim(access, "member"),
			group: claim(access, "group"),
			group_key: claim(access, "group_key"),
			sid: claim(access, "sid") ?? claim(id, "sid"),
			signed_in_at: this.now(),
			access: {
				[FINGERS_APP]: { token: tokens.accessToken, expires_at: this.now() + tokens.expiresInSeconds * 1000 },
			},
		};
	}

	private async revokeQuietly(refreshToken: string, trace: TraceContext): Promise<void> {
		try {
			await this.client.revoke(
				{ clientId: this.clientId, token: refreshToken, tokenTypeHint: "refresh_token" },
				trace,
			);
		} catch (error) {
			this.log.log("warn", "previous sign-in not revoked", {
				reason: error instanceof Error ? error.message : String(error),
				trace_id: trace.traceId,
				span_id: trace.spanId,
			});
		}
	}
}
