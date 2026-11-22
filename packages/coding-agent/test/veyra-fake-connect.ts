/**
 * A fake Veyra Connect for the `fingers login` tests: the OIDC endpoints Fingers uses, answering as Connect does
 * (doc/OIDC.md in veyraco/connect): discovery, the RFC 8628 device authorization and device_code grant, the refresh
 * grant with RFC 8707 `resource` and refresh token rotation (a spent token presented again ends the session), RFC 7009
 * revocation, and the organization lookup of Connect's public API. Polls answer from a script so every device-flow
 * error can be produced.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type PollAnswer = "pending" | "slow_down" | "denied" | "expired" | "allow" | "server_error" | "invalid_grant";

export interface FakeConnectOptions {
	/** Answers to successive device_code polls; "allow" once it runs out. */
	polls?: PollAnswer[];
	/** `interval` in the device authorization answer (Connect: 5). */
	interval?: number;
	/** `expires_in` in the device authorization answer (Connect: 600). */
	expiresIn?: number;
	/** Audiences the client may ask for with `resource` (Connect's fingers-cli today: connect). */
	resources?: string[];
	/** Serve `revocation_endpoint` in discovery (Connect main does not yet: item oidc-sessions). */
	revocation?: boolean;
	/** A scripted error for the device authorization request. */
	startError?: { status: number; error: string; description?: string; retryAfter?: number };
	/** Discovery `issuer` (default: the server's own origin). */
	issuerOverride?: string;
	/** Discovery token endpoint (default: on the server's own origin). */
	tokenEndpointOverride?: string;
}

export interface RecordedRequest {
	method: string;
	path: string;
	form: Record<string, string>;
	headers: Record<string, string | string[] | undefined>;
}

interface RefreshRecord {
	sid: string;
	used: boolean;
}

interface SessionRecord {
	sid: string;
	ended: boolean;
}

const ORG = { id: "org_7aR2cT", code: "acme", name: "Acme Robotics", tier: "medium" };

function base64url(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** A JWT-shaped token. Fingers only reads claims for display; Connect and the apps verify the signature. */
export function fakeJwt(header: Record<string, unknown>, payload: Record<string, unknown>): string {
	return `${base64url(header)}.${base64url(payload)}.${randomBytes(32).toString("base64url")}`;
}

export class FakeConnect {
	readonly requests: RecordedRequest[] = [];
	/** Every token the fake ever issued: no file, log or output may contain one. */
	readonly issuedSecrets: string[] = [];
	readonly revoked: string[] = [];
	readonly refreshesByAudience = new Map<string, number>();
	polls: PollAnswer[];
	private readonly options: FakeConnectOptions;
	private server: Server | undefined;
	private origin = "";
	private readonly deviceCodes = new Map<string, { status: "pending" | "redeemed" }>();
	private readonly refreshTokens = new Map<string, RefreshRecord>();
	private readonly sessions = new Map<string, SessionRecord>();
	private readonly accessTokens = new Map<string, { aud: string; sid: string }>();
	private sessionCounter = 0;
	/** Delay before answering a refresh, to make two refreshes overlap. */
	refreshDelayMs = 0;
	/** The organization's tier and apps as the lookup answers them (the ee gate's facts). */
	orgTier: string = ORG.tier;
	orgApps: string[] = ["connect", "fingers", "brain"];
	/** A scripted answer for the organization lookup instead of the organization, e.g. 503 or 403. */
	orgAnswer: { status: number; body: Record<string, unknown> } | undefined;

	constructor(options: FakeConnectOptions = {}) {
		this.options = options;
		this.polls = [...(options.polls ?? [])];
	}

	get issuer(): string {
		return this.origin;
	}

	async start(): Promise<this> {
		this.server = createServer((req, res) => {
			void this.handle(req, res).catch((error: unknown) => {
				res.writeHead(500, { "content-type": "text/plain" });
				res.end(String(error));
			});
		});
		await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
		const { port } = this.server.address() as AddressInfo;
		this.origin = `http://127.0.0.1:${port}`;
		return this;
	}

	async stop(): Promise<void> {
		if (!this.server) return;
		this.server.closeAllConnections();
		await new Promise<void>((resolve) => this.server!.close(() => resolve()));
	}

	requestsTo(path: string): RecordedRequest[] {
		return this.requests.filter((request) => request.path === path);
	}

	/** Whether the app session a refresh token belongs to is still live at Connect. */
	sessionLive(refreshToken: string): boolean {
		const record = this.refreshTokens.get(refreshToken);
		return record !== undefined && this.sessions.get(record.sid)?.ended === false;
	}

	liveSessions(): number {
		return [...this.sessions.values()].filter((session) => !session.ended).length;
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", this.origin);
		const body = await readBody(req);
		const form = Object.fromEntries(new URLSearchParams(body));
		this.requests.push({ method: req.method ?? "GET", path: url.pathname, form, headers: req.headers });

		if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
			json(res, 200, {
				issuer: this.options.issuerOverride ?? this.origin,
				authorization_endpoint: `${this.origin}/oauth2/authorize`,
				token_endpoint: this.options.tokenEndpointOverride ?? `${this.origin}/oauth2/token`,
				userinfo_endpoint: `${this.origin}/oauth2/userinfo`,
				device_authorization_endpoint: `${this.origin}/oauth2/device_authorization`,
				...(this.options.revocation === false ? {} : { revocation_endpoint: `${this.origin}/oauth2/revoke` }),
				jwks_uri: `${this.origin}/.well-known/jwks.json`,
				grant_types_supported: [
					"authorization_code",
					"refresh_token",
					"urn:ietf:params:oauth:grant-type:device_code",
				],
				token_endpoint_auth_methods_supported: ["private_key_jwt", "none"],
			});
			return;
		}
		const orgMatch = url.pathname.match(/^\/connect\/v1\/organizations\/([^/]+)$/);
		if (req.method === "POST" && url.pathname === "/oauth2/device_authorization") this.deviceAuthorization(res, form);
		else if (req.method === "POST" && url.pathname === "/oauth2/token") await this.token(res, form);
		else if (req.method === "POST" && url.pathname === "/oauth2/revoke" && this.options.revocation !== false) {
			this.revoke(res, form);
		} else if (req.method === "GET" && orgMatch) this.organization(res, req, orgMatch[1]!);
		else json(res, 404, { error: "not_found" });
	}

	private deviceAuthorization(res: ServerResponse, form: Record<string, string>): void {
		if (this.options.startError) {
			const { status, error, description, retryAfter } = this.options.startError;
			json(res, status, { error, error_description: description ?? error }, retryAfter);
			return;
		}
		if (form.client_id !== "fingers-cli") {
			json(res, 401, { error: "invalid_client", error_description: "Unknown client." });
			return;
		}
		const deviceCode = `vdc_${randomBytes(32).toString("base64url")}`;
		this.issuedSecrets.push(deviceCode);
		this.deviceCodes.set(deviceCode, { status: "pending" });
		json(res, 200, {
			device_code: deviceCode,
			user_code: "WDJB-MJHT",
			verification_uri: `${this.origin}/device`,
			verification_uri_complete: `${this.origin}/device?user_code=WDJB-MJHT`,
			expires_in: this.options.expiresIn ?? 600,
			interval: this.options.interval ?? 5,
		});
	}

	private async token(res: ServerResponse, form: Record<string, string>): Promise<void> {
		if (form.client_id !== "fingers-cli") {
			json(res, 401, { error: "invalid_client", error_description: "Unknown client." });
		} else if (form.grant_type === "urn:ietf:params:oauth:grant-type:device_code") this.pollDevice(res, form);
		else if (form.grant_type === "refresh_token") await this.refresh(res, form);
		else json(res, 400, { error: "unsupported_grant_type", error_description: "No." });
	}

	private pollDevice(res: ServerResponse, form: Record<string, string>): void {
		const record = this.deviceCodes.get(form.device_code ?? "");
		if (!record || record.status === "redeemed") {
			json(res, 400, { error: "invalid_grant", error_description: "The device code is not valid." });
			return;
		}
		const answer = this.polls.shift() ?? "allow";
		switch (answer) {
			case "pending":
				json(res, 400, { error: "authorization_pending", error_description: "Not answered yet." });
				return;
			case "slow_down":
				json(res, 400, { error: "slow_down", error_description: "Poll every 10 seconds." });
				return;
			case "denied":
				json(res, 400, { error: "access_denied", error_description: "The person denied this device." });
				return;
			case "expired":
				json(res, 400, { error: "expired_token", error_description: "The device code has expired." });
				return;
			case "invalid_grant":
				json(res, 400, { error: "invalid_grant", error_description: "The device code was used." });
				return;
			case "server_error":
				res.writeHead(503, { "content-type": "text/plain" });
				res.end("upstream down");
				return;
			case "allow": {
				record.status = "redeemed";
				this.sessionCounter++;
				const sid = `ses_${this.sessionCounter}`;
				this.sessions.set(sid, { sid, ended: false });
				json(res, 200, this.tokensFor(sid, "fingers", true));
				return;
			}
		}
	}

	private async refresh(res: ServerResponse, form: Record<string, string>): Promise<void> {
		const record = this.refreshTokens.get(form.refresh_token ?? "");
		if (!record) {
			json(res, 400, { error: "invalid_grant", error_description: "The refresh token is not valid." });
			return;
		}
		if (record.used) {
			// Connect: a spent refresh token presented again ends its app session.
			this.endSession(record.sid);
			json(res, 400, { error: "invalid_grant", error_description: "The refresh token is not valid." });
			return;
		}
		if (this.sessions.get(record.sid)?.ended) {
			json(res, 400, { error: "invalid_grant", error_description: "The session has ended." });
			return;
		}
		const resource = form.resource;
		const allowed = this.options.resources ?? ["connect"];
		if (resource !== undefined && resource !== "fingers" && !allowed.includes(resource)) {
			json(res, 400, { error: "invalid_target", error_description: `This client can't ask for ${resource}.` });
			return;
		}
		record.used = true;
		if (this.refreshDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.refreshDelayMs));
		const aud = resource ?? "fingers";
		this.refreshesByAudience.set(aud, (this.refreshesByAudience.get(aud) ?? 0) + 1);
		json(res, 200, this.tokensFor(record.sid, aud, false));
	}

	private revoke(res: ServerResponse, form: Record<string, string>): void {
		const token = form.token ?? "";
		this.revoked.push(token);
		const record = this.refreshTokens.get(token);
		if (record && form.client_id === "fingers-cli") this.endSession(record.sid);
		// RFC 7009 2.2: 200 whether or not the token was valid.
		res.writeHead(200, { "cache-control": "no-store" });
		res.end();
	}

	private organization(res: ServerResponse, req: IncomingMessage, org: string): void {
		const token = (req.headers.authorization ?? "").match(/^Bearer (.+)$/)?.[1];
		const access = token ? this.accessTokens.get(token) : undefined;
		if (!access || access.aud !== "connect" || this.sessions.get(access.sid)?.ended) {
			res.writeHead(401, { "content-type": "application/problem+json" });
			res.end(JSON.stringify({ type: "about:blank", title: "Unauthorized", status: 401, code: "unauthenticated" }));
			return;
		}
		if (org !== ORG.id) {
			json(res, 404, { code: "not_found" });
			return;
		}
		if (this.orgAnswer) {
			json(res, this.orgAnswer.status, this.orgAnswer.body);
			return;
		}
		json(res, 200, {
			id: ORG.id,
			code: ORG.code,
			name: ORG.name,
			tier: this.orgTier,
			apps_enabled: this.orgApps,
			my_membership: { member_id: "mem_9", group_id: "grp_editor", group_name: "Editor" },
		});
	}

	private endSession(sid: string): void {
		const session = this.sessions.get(sid);
		if (session) session.ended = true;
	}

	private tokensFor(sid: string, aud: string, withIdToken: boolean): Record<string, unknown> {
		const now = Math.floor(Date.now() / 1000);
		const accessToken = fakeJwt(
			{ alg: "EdDSA", typ: "at+jwt", kid: "k1" },
			{
				iss: this.origin,
				aud,
				sub: "usr_ada",
				sub_type: "person",
				org: ORG.id,
				member: "mem_9",
				group: "grp_editor",
				group_key: "editor",
				client_id: "fingers-cli",
				sid,
				jti: randomBytes(8).toString("hex"),
				iat: now,
				exp: now + 300,
			},
		);
		const refreshToken = `vrt_${randomBytes(24).toString("base64url")}`;
		this.refreshTokens.set(refreshToken, { sid, used: false });
		this.accessTokens.set(accessToken, { aud, sid });
		this.issuedSecrets.push(accessToken, refreshToken);
		const response: Record<string, unknown> = {
			access_token: accessToken,
			token_type: "Bearer",
			expires_in: 300,
			scope: "openid profile email offline_access",
			refresh_token: refreshToken,
		};
		if (withIdToken) {
			const idToken = fakeJwt(
				{ alg: "EdDSA", typ: "JWT", kid: "k1" },
				{
					iss: this.origin,
					aud: "fingers-cli",
					azp: "fingers-cli",
					sub: "usr_ada",
					sid,
					auth_time: now,
					org: ORG.id,
					email: "ada@acme.dev",
					email_verified: true,
					name: "Ada Lovelace",
					iat: now,
					exp: now + 300,
				},
			);
			this.issuedSecrets.push(idToken);
			response.id_token = idToken;
		}
		return response;
	}
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

function json(res: ServerResponse, status: number, body: unknown, retryAfter?: number): void {
	const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
	if (retryAfter !== undefined) headers["retry-after"] = String(retryAfter);
	res.writeHead(status, headers);
	res.end(JSON.stringify(body));
}

export const FAKE_ORG = ORG;
