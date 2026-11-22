/**
 * HTTP calls to Veyra Connect's OAuth endpoints for a public client (no secret: Connect relies on the device flow and
 * refresh token rotation): discovery, the RFC 8628 device authorization and device_code grant, the refresh grant with
 * RFC 8707 `resource`, RFC 7009 revocation, and authenticated GETs on the apps' APIs.
 *
 * Every request carries an `X-Request-Id` and a W3C `traceparent` (one trace per user operation, a span per request,
 * contracts/v1/logging.md) and is logged without any token or code.
 */
import { randomUUID } from "node:crypto";
import { childSpan, continueTrace, formatTraceparent, type TraceContext } from "../trace-context.ts";
import { ConnectConfigError } from "./connect-config.ts";
import { silentVeyraLog, type VeyraLog } from "./veyra-log.ts";

/** One user operation (sign in, refresh, sign out): its requests share the trace id. */
export function newVeyraTrace(): TraceContext {
	return continueTrace(undefined).context;
}

export interface ConnectMetadata {
	issuer: string;
	tokenEndpoint: string;
	deviceAuthorizationEndpoint: string;
	/** RFC 7009. Connect lists it once its revocation endpoint exists. */
	revocationEndpoint?: string;
}

export interface DeviceAuthorization {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	expiresInSeconds: number;
	intervalSeconds: number;
}

export interface TokenSet {
	accessToken: string;
	expiresInSeconds: number;
	scope?: string;
	refreshToken?: string;
	idToken?: string;
}

/** An OAuth error answer (`{error, error_description}`, RFC 6749 5.2 / RFC 8628 3.5). */
export class OAuthResponseError extends Error {
	readonly error: string;
	readonly description: string | undefined;
	readonly status: number;
	readonly retryAfterSeconds: number | undefined;

	constructor(error: string, description: string | undefined, status: number, retryAfterSeconds?: number) {
		super(description ? `${error}: ${description}` : error);
		this.name = "OAuthResponseError";
		this.error = error;
		this.description = description;
		this.status = status;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

/** Connect could not be reached, timed out, or answered with something that is not an OAuth answer. */
export class ConnectUnavailableError extends Error {
	readonly status: number | undefined;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "ConnectUnavailableError";
		this.status = status;
	}
}

/** A non-2xx answer from an app's API (application/problem+json, contracts/v1/http.md). */
export class VeyraApiError extends Error {
	readonly status: number;
	readonly code: string | undefined;

	constructor(status: number, code: string | undefined, title: string | undefined) {
		super(`${status}${code ? ` ${code}` : ""}${title ? `: ${title}` : ""}`);
		this.name = "VeyraApiError";
		this.status = status;
		this.code = code;
	}
}

export interface ConnectClientOptions {
	fetch?: typeof fetch;
	/** `fingers/<version> (<platform>)`: Connect shows the computer's OS on the confirm page from it. */
	userAgent?: string;
	log?: VeyraLog;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** An http(s) URL on the issuer's origin, or undefined when absent. Anything else is refused. */
function sameOriginEndpoint(metadata: Record<string, unknown>, name: string, issuer: string): string | undefined {
	const value = metadata[name];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !URL.canParse(value)) {
		throw new ConnectConfigError(`Connect's discovery document has an invalid ${name}`);
	}
	if (new URL(value).origin !== new URL(issuer).origin) {
		throw new ConnectConfigError(`Connect's ${name} is on another host (${new URL(value).origin}); refusing it`);
	}
	return value;
}

export class ConnectOidcClient {
	readonly issuer: string;
	private readonly fetchImpl: typeof fetch;
	private readonly userAgent: string | undefined;
	private readonly log: VeyraLog;
	private readonly timeoutMs: number;
	private metadata: ConnectMetadata | undefined;

	constructor(issuer: string, options: ConnectClientOptions = {}) {
		this.issuer = issuer;
		this.fetchImpl = options.fetch ?? fetch;
		this.userAgent = options.userAgent;
		this.log = options.log ?? silentVeyraLog;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** Connect's discovery document, checked: it must name this issuer, and its endpoints must be on its origin. */
	async discover(trace: TraceContext, signal?: AbortSignal): Promise<ConnectMetadata> {
		if (this.metadata) return this.metadata;
		const response = await this.send(
			"GET",
			`${this.issuer}/.well-known/openid-configuration`,
			undefined,
			undefined,
			trace,
			signal,
		);
		const body = await this.readJson(response);
		if (!response.ok || typeof body !== "object" || body === null) {
			throw new ConnectUnavailableError(`Connect's discovery document is not available (${response.status})`);
		}
		const document = body as Record<string, unknown>;
		if (document.issuer !== this.issuer) {
			throw new ConnectConfigError(
				`Connect's discovery document names issuer ${String(document.issuer)}, not ${this.issuer}`,
			);
		}
		const tokenEndpoint = sameOriginEndpoint(document, "token_endpoint", this.issuer);
		const deviceAuthorizationEndpoint = sameOriginEndpoint(document, "device_authorization_endpoint", this.issuer);
		if (!tokenEndpoint || !deviceAuthorizationEndpoint) {
			throw new ConnectConfigError("This Connect has no device sign-in (device_authorization_endpoint)");
		}
		this.metadata = {
			issuer: this.issuer,
			tokenEndpoint,
			deviceAuthorizationEndpoint,
			revocationEndpoint: sameOriginEndpoint(document, "revocation_endpoint", this.issuer),
		};
		return this.metadata;
	}

	/** RFC 8628 3.1: ask for a device code and a user code. */
	async startDeviceAuthorization(
		request: { clientId: string; scope: string; deviceName?: string; appVersion?: string },
		trace: TraceContext,
		signal?: AbortSignal,
	): Promise<DeviceAuthorization> {
		const { deviceAuthorizationEndpoint } = await this.discover(trace, signal);
		const form: Record<string, string> = { client_id: request.clientId, scope: request.scope };
		if (request.deviceName) form.device_name = request.deviceName;
		if (request.appVersion) form.app_version = request.appVersion;
		const body = await this.postForm(deviceAuthorizationEndpoint, form, trace, signal);
		const deviceCode = stringField(body.device_code);
		const userCode = stringField(body.user_code);
		const verificationUri = stringField(body.verification_uri);
		const expiresIn = numberField(body.expires_in);
		if (!deviceCode || !userCode || !verificationUri || expiresIn === undefined) {
			throw new ConnectUnavailableError("Connect's device authorization answer is incomplete");
		}
		const complete = stringField(body.verification_uri_complete);
		return {
			deviceCode,
			userCode,
			verificationUri: checkPageUrl(verificationUri, this.issuer),
			verificationUriComplete: complete ? checkPageUrl(complete, this.issuer) : undefined,
			expiresInSeconds: expiresIn,
			// RFC 8628 3.2: 5 seconds when the server names no interval.
			intervalSeconds: numberField(body.interval) ?? 5,
		};
	}

	/** RFC 8628 3.4: one poll. Pending, slow_down, denied and expired arrive as OAuthResponseError. */
	async pollDeviceToken(
		request: { clientId: string; deviceCode: string },
		trace: TraceContext,
		signal?: AbortSignal,
	): Promise<TokenSet> {
		const { tokenEndpoint } = await this.discover(trace, signal);
		const body = await this.postForm(
			tokenEndpoint,
			{
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: request.deviceCode,
				client_id: request.clientId,
			},
			trace,
			signal,
		);
		return parseTokenSet(body);
	}

	/** The refresh grant; `resource` (RFC 8707) asks for a token for another app. */
	async refresh(
		request: { clientId: string; refreshToken: string; resource?: string },
		trace: TraceContext,
		signal?: AbortSignal,
	): Promise<TokenSet> {
		const { tokenEndpoint } = await this.discover(trace, signal);
		const form: Record<string, string> = {
			grant_type: "refresh_token",
			refresh_token: request.refreshToken,
			client_id: request.clientId,
		};
		if (request.resource) form.resource = request.resource;
		return parseTokenSet(await this.postForm(tokenEndpoint, form, trace, signal));
	}

	/**
	 * RFC 7009: revoke a refresh token. "unsupported" when Connect lists no revocation endpoint. Errors throw
	 * (OAuthResponseError or ConnectUnavailableError).
	 */
	async revoke(
		request: { clientId: string; token: string; tokenTypeHint: "refresh_token" | "access_token" },
		trace: TraceContext,
		signal?: AbortSignal,
	): Promise<"revoked" | "unsupported"> {
		const { revocationEndpoint } = await this.discover(trace, signal);
		if (!revocationEndpoint) return "unsupported";
		await this.postForm(
			revocationEndpoint,
			{ token: request.token, token_type_hint: request.tokenTypeHint, client_id: request.clientId },
			trace,
			signal,
			{ allowEmpty: true },
		);
		return "revoked";
	}

	/** GET an app API resource with a Bearer token. */
	async getJson(url: string, accessToken: string, trace: TraceContext, signal?: AbortSignal): Promise<unknown> {
		const response = await this.send("GET", url, undefined, accessToken, trace, signal);
		const body = await this.readJson(response);
		if (!response.ok) {
			const problem = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
			throw new VeyraApiError(response.status, stringField(problem.code), stringField(problem.title));
		}
		return body;
	}

	private async postForm(
		url: string,
		form: Record<string, string>,
		trace: TraceContext,
		signal: AbortSignal | undefined,
		options: { allowEmpty?: boolean } = {},
	): Promise<Record<string, unknown>> {
		const response = await this.send("POST", url, new URLSearchParams(form), undefined, trace, signal);
		const body = await this.readJson(response);
		const object = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
		const oauthError = object ? stringField(object.error) : undefined;
		if (oauthError && !response.ok) {
			const retryAfter = Number(response.headers.get("retry-after"));
			throw new OAuthResponseError(
				oauthError,
				stringField(object?.error_description),
				response.status,
				Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
			);
		}
		if (!response.ok) {
			throw new ConnectUnavailableError(`Connect answered ${response.status}`, response.status);
		}
		if (!object) {
			if (options.allowEmpty) return {};
			throw new ConnectUnavailableError("Connect's answer is not JSON");
		}
		return object;
	}

	private async readJson(response: Response): Promise<unknown> {
		const text = await response.text().catch(() => "");
		if (!text) return undefined;
		try {
			return JSON.parse(text) as unknown;
		} catch {
			return undefined;
		}
	}

	private async send(
		method: "GET" | "POST",
		url: string,
		body: URLSearchParams | undefined,
		accessToken: string | undefined,
		trace: TraceContext,
		signal: AbortSignal | undefined,
	): Promise<Response> {
		const span = childSpan(trace);
		const requestId = randomUUID();
		const headers: Record<string, string> = {
			accept: "application/json",
			"x-request-id": requestId,
			traceparent: formatTraceparent(span),
		};
		if (this.userAgent) headers["user-agent"] = this.userAgent;
		if (body) headers["content-type"] = "application/x-www-form-urlencoded";
		if (accessToken) headers.authorization = `Bearer ${accessToken}`;
		const endpoint = new URL(url).pathname;
		const started = Date.now();
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const fields = { method, endpoint, request_id: requestId, trace_id: span.traceId, span_id: span.spanId };
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method,
				headers,
				body,
				redirect: "error",
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
		} catch (error) {
			signal?.throwIfAborted();
			const reason = timeout.aborted ? `timed out after ${this.timeoutMs / 1000} s` : describeFetchError(error);
			this.log.log("warn", "connect request failed", { ...fields, duration_ms: Date.now() - started, reason });
			throw new ConnectUnavailableError(`Connect could not be reached (${reason})`);
		}
		const oauthError = !response.ok ? await peekOAuthError(response) : undefined;
		const quiet = oauthError === "authorization_pending";
		this.log.log(quiet ? "debug" : response.status >= 500 ? "warn" : "info", "connect request", {
			...fields,
			status: response.status,
			duration_ms: Date.now() - started,
			oauth_error: oauthError,
		});
		return response;
	}
}

/** The OAuth `error` of an error answer, read from a clone so the body stays readable. */
async function peekOAuthError(response: Response): Promise<string | undefined> {
	try {
		const body = (await response.clone().json()) as unknown;
		return typeof body === "object" && body !== null
			? stringField((body as Record<string, unknown>).error)
			: undefined;
	} catch {
		return undefined;
	}
}

function describeFetchError(error: unknown): string {
	if (error instanceof Error) {
		const cause = (error as Error & { cause?: unknown }).cause;
		const code = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
		return typeof code === "string" ? code : error.message;
	}
	return String(error);
}

/**
 * The page the person opens: Fingers shows it and hands it to the browser, so it must be a page of this Connect, on
 * the issuer's own origin (Connect builds it as `<issuer>/device`, doc/OIDC.md), never another host or scheme. A
 * tampered answer pointing elsewhere could send the person to a look-alike page that phishes the code. The refused
 * address is not echoed, so it never reaches the screen.
 */
function checkPageUrl(value: string, issuer: string): string {
	if (!URL.canParse(value)) throw new ConnectUnavailableError("Connect's verification address is not a URL");
	const url = new URL(value);
	const issuerUrl = new URL(issuer);
	const allowHttp = issuerUrl.protocol === "http:";
	if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
		throw new ConnectConfigError("Connect's verification address is not an https page; refusing it");
	}
	if (url.origin !== issuerUrl.origin) {
		throw new ConnectConfigError(
			`Connect's verification address is not on ${issuerUrl.origin}, the Connect you sign in to; refusing it`,
		);
	}
	return url.href;
}

function parseTokenSet(body: Record<string, unknown>): TokenSet {
	const accessToken = stringField(body.access_token);
	const tokenType = stringField(body.token_type);
	if (!accessToken || tokenType?.toLowerCase() !== "bearer") {
		throw new ConnectUnavailableError("Connect's token answer has no bearer access token");
	}
	return {
		accessToken,
		expiresInSeconds: numberField(body.expires_in) ?? 300,
		scope: stringField(body.scope),
		refreshToken: stringField(body.refresh_token),
		idToken: stringField(body.id_token),
	};
}
