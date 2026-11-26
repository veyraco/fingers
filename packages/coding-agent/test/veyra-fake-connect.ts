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
	/** `verification_uri` in the device authorization answer (default: `<issuer>/device`). */
	verificationUriOverride?: string;
	/** `verification_uri_complete` in the device authorization answer (default: `<issuer>/device?user_code=…`). */
	verificationUriCompleteOverride?: string;
	/** Fields of the organization lookup answer (default: FAKE_ORG). */
	orgOverride?: Partial<{ name: string; code: string; tier: string }>;
	/** The member's group name in the organization lookup (default: Editor). */
	groupNameOverride?: string;
	/** Claims of the ID token (default: Ada Lovelace, ada@example.com). */
	idTokenClaimsOverride?: Record<string, unknown>;
	/** A scripted OAuth error for the revocation request (default: 200, RFC 7009 2.2). */
	revokeError?: { status: number; error: string; description?: string };
}

export interface RecordedRequest {
	method: string;
	path: string;
	/** The query string, with its `?` (empty when none). */
	search: string;
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
	/** Delay before answering a revocation. */
	revokeDelayMs = 0;
	/** The organization's tier and apps as the lookup answers them (the ee gate's facts). */
	orgTier: string = ORG.tier;
	orgApps: string[] = ["connect", "fingers", "brain"];
	/** A scripted answer for the organization lookup instead of the organization, e.g. 503 or 403. */
	orgAnswer: { status: number; body: Record<string, unknown> } | undefined;
	/** The organization's model connections (connect.yaml `ModelConnection`) the list answers. */
	modelConnections: Array<Record<string, unknown>> = [];
	/** Connect filters the list by `app`; off, the fake answers every connection (to test Fingers' own check). */
	filterConnectionsByApp = true;
	/** A scripted answer for the model connection list instead of the list, e.g. 403 without models:read. */
	modelConnectionsAnswer: { status: number; body: Record<string, unknown> } | undefined;
	/**
	 * Hands' model proxy door for the Fingers CLI (hands.yaml "Model calls from the Fingers CLI") on the same API
	 * origin: a person's token for `hands` is required; the call then goes to `handsUpstream` (a fake provider) with
	 * the provider key added here, as Hands adds the leased key, and only the request headers Hands passes
	 * (hands providers.ts PASSED_REQUEST_HEADERS). `handsRefusal` answers instead, as Hands refuses; Hands' own 401s
	 * carry `WWW-Authenticate: Bearer realm="hands"`.
	 */
	handsUpstream: string | undefined;
	handsRefusal: { status: number; body: Record<string, unknown>; headers?: Record<string, string> } | undefined;
	/** The provider key the fake Hands adds upstream: it must never reach Fingers, a file or a log. */
	readonly handsProviderKey = `sk-ant-api03-${randomBytes(16).toString("hex")}`;

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
		this.requests.push({
			method: req.method ?? "GET",
			path: url.pathname,
			search: url.search,
			form,
			headers: req.headers,
		});

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
		const connectionsMatch = url.pathname.match(/^\/connect\/v1\/organizations\/([^/]+)\/model-connections$/);
		const proxyMatch = url.pathname.match(/^\/hands\/v1\/model-proxy\/([^/]+)\/(anthropic|openai|google)(\/.*)$/);
		if (proxyMatch) {
			await this.handsDoor(req, res, body, proxyMatch[3]!);
			return;
		}
		if (req.method === "POST" && url.pathname === "/oauth2/device_authorization") this.deviceAuthorization(res, form);
		else if (req.method === "POST" && url.pathname === "/oauth2/token") await this.token(res, form);
		else if (req.method === "POST" && url.pathname === "/oauth2/revoke" && this.options.revocation !== false) {
			if (this.revokeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.revokeDelayMs));
			this.revoke(res, form);
		} else if (req.method === "GET" && orgMatch) this.organization(res, req, orgMatch[1]!);
		else if (req.method === "GET" && connectionsMatch) this.listModelConnections(res, req, url, connectionsMatch[1]!);
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
			verification_uri: this.options.verificationUriOverride ?? `${this.origin}/device`,
			verification_uri_complete:
				this.options.verificationUriCompleteOverride ?? `${this.origin}/device?user_code=WDJB-MJHT`,
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
		if (this.options.revokeError) {
			const { status, error, description } = this.options.revokeError;
			json(res, status, { error, error_description: description ?? error });
			return;
		}
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
			...this.options.orgOverride,
			apps_enabled: this.orgApps,
			my_membership: {
				member_id: "mem_9",
				group_id: "grp_editor",
				group_name: this.options.groupNameOverride ?? "Editor",
			},
		});
	}

	/** The live access token of `req` for `aud`, or undefined. */
	private bearerFor(req: IncomingMessage, aud: string): string | undefined {
		const token = (req.headers.authorization ?? "").match(/^Bearer (.+)$/)?.[1];
		const access = token ? this.accessTokens.get(token) : undefined;
		if (!access || access.aud !== aud || this.sessions.get(access.sid)?.ended) return undefined;
		return token;
	}

	private listModelConnections(res: ServerResponse, req: IncomingMessage, url: URL, org: string): void {
		if (!this.bearerFor(req, "connect")) {
			json(res, 401, { status: 401, code: "unauthenticated", title: "Unauthorized" });
			return;
		}
		if (org !== ORG.id) {
			json(res, 404, { code: "not_found" });
			return;
		}
		if (this.modelConnectionsAnswer) {
			json(res, this.modelConnectionsAnswer.status, this.modelConnectionsAnswer.body);
			return;
		}
		const app = url.searchParams.get("app");
		const data = this.modelConnections.filter(
			(connection) =>
				!this.filterConnectionsByApp ||
				!app ||
				(Array.isArray(connection.apps) && (connection.apps as unknown[]).includes(app)),
		);
		json(res, 200, { data });
	}

	private async handsDoor(req: IncomingMessage, res: ServerResponse, body: string, rest: string): Promise<void> {
		if (!this.bearerFor(req, "hands")) {
			res.setHeader("www-authenticate", 'Bearer realm="hands"');
			json(res, 401, {
				type: "error",
				error: { type: "authentication_error", message: "A Connect access token for Hands is required." },
			});
			return;
		}
		if (this.handsRefusal) {
			for (const [name, value] of Object.entries(this.handsRefusal.headers ?? {})) res.setHeader(name, value);
			json(res, this.handsRefusal.status, this.handsRefusal.body);
			return;
		}
		if (!this.handsUpstream) {
			json(res, 503, { type: "error", error: { type: "overloaded_error", message: "no upstream" } });
			return;
		}
		const passed: Record<string, string> = {};
		for (const name of ["accept", "anthropic-version", "anthropic-beta", "openai-beta", "user-agent"]) {
			const value = req.headers[name];
			if (typeof value === "string") passed[name] = value;
		}
		const upstream = await fetch(`${this.handsUpstream}${rest}`, {
			method: req.method,
			headers: {
				...passed,
				"content-type": "application/json",
				"x-api-key": this.handsProviderKey,
				authorization: `Bearer ${this.handsProviderKey}`,
			},
			body,
		});
		res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
		res.end(Buffer.from(await upstream.arrayBuffer()));
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
					email: "ada@example.com",
					email_verified: true,
					name: "Ada Lovelace",
					iat: now,
					exp: now + 300,
					...this.options.idTokenClaimsOverride,
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
