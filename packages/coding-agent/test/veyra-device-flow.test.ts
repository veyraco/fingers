/**
 * `fingers login`'s RFC 8628 device flow against a fake Connect: the start request, every poll answer
 * (authorization_pending, slow_down, access_denied, expired_token), the code's lifetime, transient failures,
 * cancellation, and the discovery checks that keep a token from going to another host.
 */
import { afterEach, describe, expect, it } from "vitest";
import { type DeviceCodePrompt, DeviceFlowError, runDeviceFlow } from "../src/core/veyra/device-flow.ts";
import { ConnectOidcClient } from "../src/core/veyra/oidc-client.ts";
import { FakeConnect, type FakeConnectOptions } from "./veyra-fake-connect.ts";

let fake: FakeConnect | undefined;

afterEach(async () => {
	await fake?.stop();
	fake = undefined;
});

async function startFake(options: FakeConnectOptions = {}): Promise<FakeConnect> {
	fake = await new FakeConnect(options).start();
	return fake;
}

/** A device flow whose sleeps only advance a fake clock and are recorded. */
function flow(connect: FakeConnect, extra: { signal?: AbortSignal } = {}) {
	let clock = 1_000_000;
	const delays: number[] = [];
	const codes: DeviceCodePrompt[] = [];
	const client = new ConnectOidcClient(connect.issuer, { userAgent: "fingers/0.1.0 (test)" });
	const run = () =>
		runDeviceFlow({
			client,
			clientId: "fingers-cli",
			deviceName: "ada-mbp",
			appVersion: "0.1.0",
			onCode: (code) => codes.push(code),
			signal: extra.signal ?? new AbortController().signal,
			now: () => clock,
			sleep: async (ms, signal) => {
				signal?.throwIfAborted();
				delays.push(ms);
				clock += ms;
			},
		});
	return { run, delays, codes };
}

async function expectFlowError(promise: Promise<unknown>, reason: DeviceFlowError["reason"]): Promise<DeviceFlowError> {
	const error = await promise.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(DeviceFlowError);
	expect((error as DeviceFlowError).reason).toBe(reason);
	return error as DeviceFlowError;
}

describe("device authorization (RFC 8628 3.1)", () => {
	it("asks as the public client fingers-cli with the device's name and version, then shows the code", async () => {
		const connect = await startFake({ polls: ["pending"] });
		const { run, codes } = flow(connect);
		const tokens = await run();

		const [start] = connect.requestsTo("/oauth2/device_authorization");
		expect(start?.form).toEqual({
			client_id: "fingers-cli",
			scope: "openid profile email offline_access",
			device_name: "ada-mbp",
			app_version: "0.1.0",
		});
		expect(start?.headers.authorization).toBeUndefined();
		expect(start?.headers["user-agent"]).toBe("fingers/0.1.0 (test)");
		expect(codes).toHaveLength(1);
		expect(codes[0]).toMatchObject({
			userCode: "WDJB-MJHT",
			verificationUri: `${connect.issuer}/device`,
			verificationUriComplete: `${connect.issuer}/device?user_code=WDJB-MJHT`,
		});
		expect(codes[0]!.expiresAt).toBe(1_000_000 + 600_000);
		expect(tokens.accessToken).toMatch(/^ey/);
		expect(tokens.refreshToken).toMatch(/^vrt_/);
		expect(tokens.idToken).toMatch(/^ey/);
	});

	it("sends a request id and a W3C traceparent on every request to Connect", async () => {
		const connect = await startFake({ polls: ["pending"] });
		await flow(connect).run();
		const ids = new Set<string>();
		for (const request of connect.requests) {
			expect(request.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
			expect(request.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
			ids.add(String(request.headers["x-request-id"]));
		}
		expect(ids.size).toBe(connect.requests.length);
		// One trace for the whole sign-in, a span per request.
		const traces = new Set(connect.requests.map((request) => String(request.headers.traceparent).split("-")[1]));
		expect(traces.size).toBe(1);
	});

	it("reports Connect's start refusals: too many sign-ins from this address (429 slow_down)", async () => {
		const connect = await startFake({
			startError: { status: 429, error: "slow_down", description: "Too many device sign-ins.", retryAfter: 30 },
		});
		const error = await expectFlowError(flow(connect).run(), "failed");
		expect(error.message).toContain("Try again in 30 seconds");
		expect(connect.requestsTo("/oauth2/token")).toHaveLength(0);
	});

	it("reports Connect's start refusals: a client that may not use the device flow", async () => {
		const connect = await startFake({
			startError: {
				status: 400,
				error: "unauthorized_client",
				description: "This client can't use the device flow.",
			},
		});
		const error = await expectFlowError(flow(connect).run(), "failed");
		expect(error.oauthError).toBe("unauthorized_client");
		expect(error.message).toContain("This client can't use the device flow.");
	});
});

describe("polling the token endpoint (RFC 8628 3.4-3.5)", () => {
	it("authorization_pending: waits the interval and polls again until the person allows it", async () => {
		const connect = await startFake({ polls: ["pending", "pending"] });
		const { run, delays } = flow(connect);
		await run();
		const polls = connect.requestsTo("/oauth2/token");
		expect(polls).toHaveLength(3);
		for (const poll of polls) {
			expect(poll.form.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
			expect(poll.form.client_id).toBe("fingers-cli");
			expect(poll.form.device_code).toMatch(/^vdc_/);
		}
		// The client waits the interval before every poll, the first included.
		expect(delays).toEqual([5000, 5000, 5000]);
	});

	it("slow_down: adds 5 seconds to this and every later poll", async () => {
		const connect = await startFake({ polls: ["slow_down", "pending", "slow_down", "pending"] });
		const { run, delays } = flow(connect);
		await run();
		expect(delays).toEqual([5000, 10000, 10000, 15000, 15000]);
	});

	it("access_denied: the person denied the device; no further polls", async () => {
		const connect = await startFake({ polls: ["pending", "denied", "pending"] });
		const error = await expectFlowError(flow(connect).run(), "denied");
		expect(error.oauthError).toBe("access_denied");
		expect(connect.requestsTo("/oauth2/token")).toHaveLength(2);
	});

	it("expired_token: Connect says the code expired; no further polls", async () => {
		const connect = await startFake({ polls: ["pending", "expired"] });
		const error = await expectFlowError(flow(connect).run(), "expired");
		expect(error.oauthError).toBe("expired_token");
		expect(connect.requestsTo("/oauth2/token")).toHaveLength(2);
	});

	it("stops at the end of the code's lifetime without polling past it", async () => {
		const connect = await startFake({ expiresIn: 12, polls: Array(10).fill("pending") });
		const { run, delays } = flow(connect);
		await expectFlowError(run(), "expired");
		expect(delays.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(12_000);
		expect(connect.requestsTo("/oauth2/token").length).toBeLessThanOrEqual(3);
	});

	it("a server error backs off (the interval doubles) and keeps polling", async () => {
		const connect = await startFake({ polls: ["server_error", "pending"] });
		const { run, delays } = flow(connect);
		await run();
		expect(delays).toEqual([5000, 10000, 10000]);
	});

	it("any other OAuth error ends the sign-in with Connect's description", async () => {
		const connect = await startFake({ polls: ["invalid_grant"] });
		const error = await expectFlowError(flow(connect).run(), "failed");
		expect(error.oauthError).toBe("invalid_grant");
		expect(error.message).toContain("The device code was used.");
	});

	it("cancelling (esc or Ctrl+C) stops the wait and polls no more", async () => {
		const connect = await startFake({ polls: Array(10).fill("pending") });
		const controller = new AbortController();
		const { run } = flow(connect, { signal: controller.signal });
		const running = run();
		controller.abort();
		await expectFlowError(running, "cancelled");
		expect(connect.requestsTo("/oauth2/token").length).toBeLessThanOrEqual(1);
	});
});

describe("discovery", () => {
	it("refuses a discovery document that names another issuer", async () => {
		const connect = await startFake({ issuerOverride: "https://connect.example.net" });
		const error = await expectFlowError(flow(connect).run(), "failed");
		expect(error.message).toContain("issuer");
		expect(connect.requestsTo("/oauth2/device_authorization")).toHaveLength(0);
	});

	it("refuses endpoints on another host, so a token never leaves the issuer", async () => {
		const connect = await startFake({ tokenEndpointOverride: "https://tokens.example.net/oauth2/token" });
		const error = await expectFlowError(flow(connect).run(), "failed");
		expect(error.message).toContain("token_endpoint");
		expect(connect.requestsTo("/oauth2/device_authorization")).toHaveLength(0);
	});
});
