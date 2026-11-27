/**
 * The OAuth 2.0 device authorization grant (RFC 8628) as `fingers login` runs it against Veyra Connect:
 * ask for a code, show it, then poll the token endpoint until the person allows or denies the device in the browser.
 *
 * Poll answers (3.5): `authorization_pending` waits another interval; `slow_down` adds 5 seconds to this and every
 * later interval; `access_denied` and `expired_token` end the sign-in. The client also stops once the code's lifetime
 * is over. A server error or dropped connection doubles the interval (up to a minute) and keeps polling.
 */
import type { TraceContext } from "../trace-context.ts";
import { FINGERS_SCOPE } from "./connect-config.ts";
import {
	type ConnectOidcClient,
	ConnectUnavailableError,
	newVeyraTrace,
	OAuthResponseError,
	type TokenSet,
} from "./oidc-client.ts";

/** What the person needs to confirm the device: shown in the terminal, opened in the browser. */
export interface DeviceCodePrompt {
	userCode: string;
	verificationUri: string;
	/** The page with the code filled in; Connect still asks the person to check it against the terminal. */
	verificationUriComplete?: string;
	/** When the code stops working, in the flow's clock (ms). */
	expiresAt: number;
	/** The code's lifetime when Connect issued it: a countdown starts from here on its own clock. */
	expiresInSeconds: number;
}

type DeviceFlowFailure = "denied" | "expired" | "cancelled" | "failed";

export class DeviceFlowError extends Error {
	readonly reason: DeviceFlowFailure;
	/** The OAuth error Connect answered with, when there was one. */
	readonly oauthError: string | undefined;

	constructor(reason: DeviceFlowFailure, message: string, oauthError?: string) {
		super(message);
		this.name = "DeviceFlowError";
		this.reason = reason;
		this.oauthError = oauthError;
	}
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

const realSleep: Sleep = (ms, signal) =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});

interface DeviceFlowOptions {
	client: ConnectOidcClient;
	clientId: string;
	scope?: string;
	/** Shown on Connect's confirm page ("Computer"). */
	deviceName?: string;
	appVersion?: string;
	onCode: (prompt: DeviceCodePrompt) => void;
	signal: AbortSignal;
	trace?: TraceContext;
	now?: () => number;
	sleep?: Sleep;
}

const SLOW_DOWN_MS = 5_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

function cancelled(): DeviceFlowError {
	return new DeviceFlowError("cancelled", "Sign-in cancelled.");
}

function startFailure(error: unknown): DeviceFlowError {
	if (error instanceof OAuthResponseError) {
		const text = (error.description ?? error.error).replace(/\.$/, "");
		const wait = error.retryAfterSeconds ? ` Try again in ${error.retryAfterSeconds} seconds.` : "";
		return new DeviceFlowError("failed", `Connect refused the sign-in: ${text}.${wait}`, error.error);
	}
	return new DeviceFlowError("failed", error instanceof Error ? error.message : String(error));
}

/** Run the device flow to its end: the token set once the person allowed the device, else a DeviceFlowError. */
export async function runDeviceFlow(options: DeviceFlowOptions): Promise<TokenSet> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? realSleep;
	const { client, signal } = options;
	const trace = options.trace ?? newVeyraTrace();

	let authorization: Awaited<ReturnType<ConnectOidcClient["startDeviceAuthorization"]>>;
	try {
		authorization = await client.startDeviceAuthorization(
			{
				clientId: options.clientId,
				scope: options.scope ?? FINGERS_SCOPE,
				deviceName: options.deviceName,
				appVersion: options.appVersion,
			},
			trace,
			signal,
		);
	} catch (error) {
		if (signal.aborted) throw cancelled();
		throw startFailure(error);
	}

	const deadline = now() + authorization.expiresInSeconds * 1000;
	options.onCode({
		userCode: authorization.userCode,
		verificationUri: authorization.verificationUri,
		verificationUriComplete: authorization.verificationUriComplete,
		expiresAt: deadline,
		expiresInSeconds: authorization.expiresInSeconds,
	});

	let intervalMs = Math.max(MIN_INTERVAL_MS, authorization.intervalSeconds * 1000);
	while (true) {
		const remaining = deadline - now();
		if (remaining <= 0) {
			throw new DeviceFlowError("expired", "The code expired before it was confirmed.");
		}
		try {
			await sleep(Math.min(intervalMs, remaining), signal);
		} catch {
			throw cancelled();
		}
		if (signal.aborted) throw cancelled();
		if (deadline - now() <= 0) {
			throw new DeviceFlowError("expired", "The code expired before it was confirmed.");
		}
		try {
			return await client.pollDeviceToken(
				{ clientId: options.clientId, deviceCode: authorization.deviceCode },
				trace,
				signal,
			);
		} catch (error) {
			if (signal.aborted) throw cancelled();
			if (error instanceof OAuthResponseError) {
				switch (error.error) {
					case "authorization_pending":
						continue;
					case "slow_down":
						intervalMs += SLOW_DOWN_MS;
						continue;
					case "access_denied":
						throw new DeviceFlowError("denied", "The sign-in was denied in the browser.", error.error);
					case "expired_token":
						throw new DeviceFlowError("expired", "The code expired before it was confirmed.", error.error);
					case "temporarily_unavailable":
						intervalMs = Math.min(intervalMs * 2, MAX_BACKOFF_MS);
						continue;
					default:
						throw new DeviceFlowError(
							"failed",
							`Connect refused the sign-in: ${error.description ?? error.error}`,
							error.error,
						);
				}
			}
			if (error instanceof ConnectUnavailableError) {
				// RFC 8628 3.5: back off on connection trouble and keep polling until the code expires.
				intervalMs = Math.min(intervalMs * 2, MAX_BACKOFF_MS);
				continue;
			}
			throw new DeviceFlowError("failed", error instanceof Error ? error.message : String(error));
		}
	}
}
