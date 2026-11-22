/**
 * The Veyra sign-in after the device flow, against a fake Connect: the refresh token lives only in the OS keychain
 * (an in-memory keychain fake here), access tokens per audience come from the refresh grant with RFC 8707
 * `resource`, rotated refresh tokens replace the old one under a cross-process lock, and logout revokes the
 * refresh token (RFC 7009) and clears the keychain. The log carries the platform fields and never a token.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeychainBlob } from "../src/core/keychain-auth-storage.ts";
import { InMemorySecretStore } from "../src/core/os-keychain.ts";
import { openVeyraSessionVault, veyraSessionAccount } from "../src/core/veyra/session-vault.ts";
import { VeyraAudienceError, VeyraAuth, VeyraSignedOutError } from "../src/core/veyra/veyra-auth.ts";
import { createVeyraLog } from "../src/core/veyra/veyra-log.ts";
import { FAKE_ORG, FakeConnect, type FakeConnectOptions } from "./veyra-fake-connect.ts";

let fake: FakeConnect | undefined;
let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "fingers-veyra-"));
});

afterEach(async () => {
	await fake?.stop();
	fake = undefined;
	rmSync(agentDir, { recursive: true, force: true });
});

async function startFake(options: FakeConnectOptions = {}): Promise<FakeConnect> {
	fake = await new FakeConnect(options).start();
	return fake;
}

interface Setup {
	auth: VeyraAuth;
	store: InMemorySecretStore;
	clock: { now: number };
}

/** A VeyraAuth on the fake, with an in-memory keychain. Pass `store` to share one keychain between "processes". */
function setup(
	connect: FakeConnect,
	options: { store?: InMemorySecretStore; env?: NodeJS.ProcessEnv; lockWaitMs?: number } = {},
): Setup {
	const store = options.store ?? new InMemorySecretStore();
	const clock = { now: Date.now() };
	const vault = openVeyraSessionVault({
		agentDir,
		issuer: connect.issuer,
		env: options.env ?? { FINGERS_CREDENTIAL_STORE: "keychain" },
		secretStore: store,
		lockWaitMs: options.lockWaitMs,
	});
	const auth = new VeyraAuth({
		issuer: connect.issuer,
		vault,
		apiUrl: connect.issuer,
		appVersion: "0.1.0",
		deviceName: "ada-mbp",
		userAgent: "fingers/0.1.0 (test)",
		log: createVeyraLog({ path: join(agentDir, "veyra.log"), version: "0.1.0", env: "test" }),
		now: () => clock.now,
		sleep: async (ms) => {
			clock.now += ms;
		},
	});
	return { auth, store, clock };
}

async function signIn(setupResult: Setup) {
	return setupResult.auth.login({ onCode: () => {}, signal: new AbortController().signal });
}

/** Every file under the agent dir, as text. */
function filesUnder(dir: string): Array<{ name: string; text: string }> {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => ({ name: entry.name, text: readFileSync(join(entry.parentPath, entry.name), "utf-8") }));
}

function storedSession(store: InMemorySecretStore): Record<string, unknown> | undefined {
	const account = [...store.items.keys()].find((key) => key.startsWith("veyra:") && !key.includes("#"));
	if (!account) return undefined;
	const text = new KeychainBlob(store, account).read();
	return text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
}

/** Hold the sign-in's lock as another fingers process would, until the returned function runs. */
async function holdSignInLock(): Promise<() => Promise<void>> {
	const marker = readdirSync(agentDir).find((name) => name.startsWith("veyra-session.") && name.endsWith(".json"));
	if (!marker) throw new Error("no sign-in marker to lock");
	return lockfile.lock(join(agentDir, marker), { stale: 30_000 });
}

function refreshTokensSent(connect: FakeConnect): string[] {
	return connect
		.requestsTo("/oauth2/token")
		.filter((request) => request.form.grant_type === "refresh_token")
		.map((request) => request.form.refresh_token ?? "");
}

function claims(token: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf-8")) as Record<string, unknown>;
}

describe("where the sign-in is kept", () => {
	it("keeps the refresh token in the OS keychain only; no file under the agent dir holds a token", async () => {
		const connect = await startFake();
		const s = setup(connect);
		await signIn(s);

		const session = storedSession(s.store);
		expect(session?.refresh_token).toMatch(/^vrt_/);
		expect(session?.issuer).toBe(connect.issuer);
		const files = filesUnder(agentDir);
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			for (const secret of connect.issuedSecrets) expect(file.text).not.toContain(secret);
		}
		const marker = files.find((file) => file.name.startsWith("veyra-session."));
		expect(marker?.text).toContain("This file holds no secret.");
	});

	it("tells who signed in without the network, and another fingers process on the same keychain sees it", async () => {
		const connect = await startFake();
		const s = setup(connect);
		const account = await signIn(s);
		expect(account).toMatchObject({
			issuer: connect.issuer,
			subject: "usr_ada",
			email: "ada@acme.dev",
			name: "Ada Lovelace",
			org: FAKE_ORG.id,
			groupKey: "editor",
			storage: { persistent: true, location: "in-memory keychain" },
		});
		const requests = connect.requests.length;
		const other = setup(connect, { store: s.store });
		expect(other.auth.account()?.email).toBe("ada@acme.dev");
		expect(connect.requests.length).toBe(requests);
	});

	it("FINGERS_CREDENTIAL_STORE=file keeps the Veyra sign-in in memory only and writes nothing", async () => {
		const connect = await startFake();
		const s = setup(connect, { env: { FINGERS_CREDENTIAL_STORE: "file" } });
		const account = await signIn(s);
		expect(account.storage.persistent).toBe(false);
		expect(account.storage.memoryReason).toContain("FINGERS_CREDENTIAL_STORE=file");
		expect(s.store.items.size).toBe(0);
		expect(filesUnder(agentDir).filter((file) => !file.name.endsWith(".log"))).toEqual([]);
		for (const file of filesUnder(agentDir)) {
			for (const secret of connect.issuedSecrets) expect(file.text).not.toContain(secret);
		}
		// Usable for this process.
		expect(await s.auth.getAccessToken("fingers")).toMatch(/^ey/);
	});

	it("no reachable keychain: the sign-in stays in memory and says why", async () => {
		const connect = await startFake();
		const s = setup(connect, { store: new InMemorySecretStore({ available: false }) });
		const account = await signIn(s);
		expect(account.storage).toMatchObject({ persistent: false });
		expect(account.storage.memoryReason).toContain("not reachable");
	});

	it("a vault change runs to its end once started: the signal only ends the wait for the lock", async () => {
		const connect = await startFake();
		const s = setup(connect);
		await signIn(s);
		const vault = openVeyraSessionVault({
			agentDir,
			issuer: connect.issuer,
			env: { FINGERS_CREDENTIAL_STORE: "keychain" },
			secretStore: s.store,
		});
		const controller = new AbortController();
		let finishChange: (() => void) | undefined;
		const changing = vault.update(async (current) => {
			await new Promise<void>((resolve) => {
				finishChange = resolve;
			});
			return { result: "written", next: { ...current!, tier: "large" } };
		}, controller.signal);
		// Abort while the change runs (the lock is held).
		await vi.waitFor(() => expect(finishChange).toBeDefined());
		controller.abort();
		finishChange?.();
		await expect(changing).resolves.toBe("written");
		expect(storedSession(s.store)?.tier).toBe("large");
		expect(vault.read()?.tier).toBe("large");
	});

	it("veyraSessionAccount never exposes a token", async () => {
		const connect = await startFake();
		const s = setup(connect);
		await signIn(s);
		const session = storedSession(s.store)!;
		const text = JSON.stringify(veyraSessionAccount(session as never, { persistent: true, location: "x" }));
		for (const secret of connect.issuedSecrets) expect(text).not.toContain(secret);
	});
});

describe("access tokens per audience", () => {
	it("gets connect, brain and eyes tokens through the refresh grant with resource, once each", async () => {
		const connect = await startFake({ resources: ["connect", "brain", "eyes"] });
		const s = setup(connect);
		await signIn(s);

		for (const audience of ["connect", "brain", "eyes"] as const) {
			const token = await s.auth.getAccessToken(audience);
			expect(claims(token).aud).toBe(audience);
			// Cached until it nears expiry: a second ask makes no request.
			expect(await s.auth.getAccessToken(audience)).toBe(token);
		}
		const refreshes = connect
			.requestsTo("/oauth2/token")
			.filter((request) => request.form.grant_type === "refresh_token");
		expect(refreshes.map((request) => request.form.resource)).toEqual(["connect", "brain", "eyes"]);
		for (const request of refreshes) {
			expect(request.form.client_id).toBe("fingers-cli");
			expect(request.headers.authorization).toBeUndefined();
		}
		expect(Object.fromEntries(connect.refreshesByAudience)).toEqual({ connect: 1, brain: 1, eyes: 1 });
	});

	it("Fingers' own audience is the sign-in's token; once it expires it refreshes without resource", async () => {
		const connect = await startFake();
		const s = setup(connect);
		await signIn(s);
		const first = await s.auth.getAccessToken("fingers");
		expect(claims(first).aud).toBe("fingers");
		expect(connect.requestsTo("/oauth2/token")).toHaveLength(1);

		s.clock.now += 10 * 60_000;
		const second = await s.auth.getAccessToken("fingers");
		expect(second).not.toBe(first);
		const refresh = connect.requestsTo("/oauth2/token").at(-1)!;
		expect(refresh.form.grant_type).toBe("refresh_token");
		expect(refresh.form.resource).toBeUndefined();
	});

	it("an access token close to expiry is refreshed", async () => {
		const connect = await startFake();
		const s = setup(connect);
		await signIn(s);
		const first = await s.auth.getAccessToken("connect");
		s.clock.now += 260_000; // 40 s left of 300
		const second = await s.auth.getAccessToken("connect");
		expect(second).not.toBe(first);
		expect(connect.refreshesByAudience.get("connect")).toBe(2);
	});

	it("each refresh writes the rotated refresh token to the keychain, so the spent one is never sent again", async () => {
		const connect = await startFake({ resources: ["connect", "brain"] });
		const s = setup(connect);
		await signIn(s);
		const original = storedSession(s.store)!.refresh_token as string;
		await s.auth.getAccessToken("connect");
		const rotated = storedSession(s.store)!.refresh_token as string;
		expect(rotated).not.toBe(original);
		await s.auth.getAccessToken("brain");
		// Connect ends the session when a spent refresh token comes back; it is still live.
		expect(connect.liveSessions()).toBe(1);
		const sent = connect.requestsTo("/oauth2/token").map((request) => request.form.refresh_token);
		expect(sent.filter((token) => token === original)).toHaveLength(1);
	});

	it("two fingers processes refreshing at once refresh once and share the token (lock, then re-read)", async () => {
		const connect = await startFake();
		const a = setup(connect);
		await signIn(a);
		const b = setup(connect, { store: a.store });
		connect.refreshDelayMs = 150;
		const [tokenA, tokenB] = await Promise.all([a.auth.getAccessToken("connect"), b.auth.getAccessToken("connect")]);
		expect(tokenA).toBe(tokenB);
		expect(connect.refreshesByAudience.get("connect")).toBe(1);
		expect(connect.liveSessions()).toBe(1);
	});

	it("a caller that stops waiting does not lose a refresh Connect already answered: the rotated token is kept and used next", async () => {
		const connect = await startFake();
		const s = setup(connect);
		await signIn(s);
		const original = storedSession(s.store)!.refresh_token as string;
		connect.refreshDelayMs = 400;
		const controller = new AbortController();
		const waiting = s.auth.getAccessToken("connect", { signal: controller.signal });
		// Stop waiting once the refresh reached Connect: Connect has spent the old refresh token by then.
		await vi.waitFor(() => expect(refreshTokensSent(connect)).toEqual([original]));
		controller.abort();
		await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
		// Only the caller's wait ended; Connect is still answering.
		expect(connect.refreshesByAudience.get("connect")).toBeUndefined();

		// The refresh finishes under the lock and keeps the rotated refresh token.
		await vi.waitFor(() => expect(storedSession(s.store)?.refresh_token).not.toBe(original), { timeout: 5_000 });
		const rotated = storedSession(s.store)!.refresh_token as string;
		expect(connect.refreshesByAudience.get("connect")).toBe(1);

		// The next refresh sends the rotated token, and the session at Connect is still live.
		connect.refreshDelayMs = 0;
		s.clock.now += 10 * 60_000;
		expect(await s.auth.getAccessToken("fingers")).toMatch(/^ey/);
		expect(refreshTokensSent(connect)).toEqual([original, rotated]);
		expect(connect.liveSessions()).toBe(1);
		expect(s.auth.account()).toBeDefined();
	});

	it("an audience Connect does not give Fingers is a clear error, and the sign-in stays", async () => {
		const connect = await startFake({ resources: ["connect"] });
		const s = setup(connect);
		await signIn(s);
		const error = await s.auth.getAccessToken("brain").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(VeyraAudienceError);
		expect((error as Error).message).toContain("brain");
		expect(await s.auth.getAccessToken("connect")).toMatch(/^ey/);
		expect(s.auth.account()).toBeDefined();
	});

	it("a refresh token Connect no longer accepts signs Fingers out and clears the keychain", async () => {
		const connect = await startFake();
		const s = setup(connect);
		await signIn(s);
		// Connect ended the session (Remove access in Connected apps).
		const refresh = storedSession(s.store)!.refresh_token as string;
		await fetch(`${connect.issuer}/oauth2/revoke`, {
			method: "POST",
			body: new URLSearchParams({ token: refresh, client_id: "fingers-cli" }),
		});
		const error = await s.auth.getAccessToken("connect").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(VeyraSignedOutError);
		expect((error as VeyraSignedOutError).reason).toBe("session_ended");
		expect(s.auth.account()).toBeUndefined();
		expect(storedSession(s.store)).toBeUndefined();
	});

	it("not signed in: asking for a token is VeyraSignedOutError without a request", async () => {
		const connect = await startFake();
		const s = setup(connect);
		const error = await s.auth.getAccessToken("connect").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(VeyraSignedOutError);
		expect((error as VeyraSignedOutError).reason).toBe("not_signed_in");
		expect(connect.requests).toHaveLength(0);
	});
});

describe("logout", () => {
	it("revokes the refresh token at Connect (RFC 7009) and clears the keychain", async () => {
		const connect = await startFake();
		const s = setup(connect);
		await signIn(s);
		const refresh = storedSession(s.store)!.refresh_token as string;

		const result = await s.auth.logout();
		expect(result).toEqual({ signedIn: true, revocation: "revoked" });
		const [revoke] = connect.requestsTo("/oauth2/revoke");
		expect(revoke?.form).toEqual({ token: refresh, token_type_hint: "refresh_token", client_id: "fingers-cli" });
		expect(connect.sessionLive(refresh)).toBe(false);
		expect([...s.store.items.keys()].filter((key) => key.startsWith("veyra:"))).toEqual([]);
		expect(s.auth.account()).toBeUndefined();
	});

	it("revokes the newest refresh token after a rotation", async () => {
		const connect = await startFake();
		const s = setup(connect);
		await signIn(s);
		await s.auth.getAccessToken("connect");
		const newest = storedSession(s.store)!.refresh_token as string;
		await s.auth.logout();
		expect(connect.revoked).toEqual([newest]);
		expect(connect.liveSessions()).toBe(0);
	});

	it("without a revocation endpoint it clears the keychain and says Connect still lists the device", async () => {
		const connect = await startFake({ revocation: false });
		const s = setup(connect);
		await signIn(s);
		const result = await s.auth.logout();
		expect(result).toEqual({ signedIn: true, revocation: "unsupported" });
		expect(storedSession(s.store)).toBeUndefined();
	});

	it("when Connect cannot be reached it still clears the keychain and reports the failed revocation", async () => {
		const connect = await startFake();
		const s = setup(connect);
		await signIn(s);
		await connect.stop();
		const result = await s.auth.logout();
		expect(result.signedIn).toBe(true);
		expect(result.revocation).toBe("failed");
		expect(storedSession(s.store)).toBeUndefined();
	});

	it("another fingers process holds the lock past the wait: logout says so, still revokes and clears the keychain", async () => {
		const connect = await startFake();
		const s = setup(connect, { lockWaitMs: 300 });
		await signIn(s);
		const refresh = storedSession(s.store)!.refresh_token as string;
		const release = await holdSignInLock();
		try {
			const result = await s.auth.logout();
			expect(result).toMatchObject({ signedIn: true, revocation: "revoked" });
			expect(result.lockProblem).toMatch(/lock/i);
			expect(connect.revoked).toEqual([refresh]);
			expect(connect.sessionLive(refresh)).toBe(false);
			expect(storedSession(s.store)).toBeUndefined();
			expect(s.auth.account()).toBeUndefined();
		} finally {
			await release();
		}
	});

	it("not signed in: nothing to revoke", async () => {
		const connect = await startFake();
		const s = setup(connect);
		expect(await s.auth.logout()).toEqual({ signedIn: false, revocation: "none" });
		expect(connect.requests).toHaveLength(0);
	});

	it("signing in again replaces the sign-in and revokes the previous one", async () => {
		const connect = await startFake();
		const s = setup(connect);
		await signIn(s);
		const first = storedSession(s.store)!.refresh_token as string;
		await signIn(s);
		expect(connect.revoked).toEqual([first]);
		expect(connect.liveSessions()).toBe(1);
		expect(storedSession(s.store)!.refresh_token).not.toBe(first);
	});
});

describe("organization and logs", () => {
	it("the log redacts the platform's secret keys at any depth and records errors with their stack", () => {
		const path = join(agentDir, "veyra.log");
		const log = createVeyraLog({ path, version: "0.1.0", env: "test" });
		log.log("warn", "probe", {
			headers: { "Set-Cookie": "sid=s3cr3t-cookie", Authorization: "Bearer s3cr3t-bearer" },
			api_key: "s3cr3t-key",
			nested: [{ client_secret: "s3cr3t-client" }],
			err: new Error("boom"),
		});
		const text = readFileSync(path, "utf-8");
		expect(text).not.toMatch(/s3cr3t/);
		const record = JSON.parse(text.trim()) as {
			headers: unknown;
			api_key: unknown;
			nested: unknown;
			err: { type: string; message: string; stack?: string };
		};
		expect(record.headers).toEqual({ "Set-Cookie": "[redacted]", Authorization: "[redacted]" });
		expect(record.api_key).toBe("[redacted]");
		expect(record.nested).toEqual([{ client_secret: "[redacted]" }]);
		expect(record.err).toMatchObject({ type: "Error", message: "boom" });
		expect(record.err.stack).toContain("boom");
	});

	it("looks up the organization with a connect token", async () => {
		const connect = await startFake();
		const s = setup(connect);
		await signIn(s);
		const org = await s.auth.organization();
		expect(org).toEqual({
			id: FAKE_ORG.id,
			code: FAKE_ORG.code,
			name: FAKE_ORG.name,
			tier: FAKE_ORG.tier,
			appsEnabled: ["connect", "fingers", "brain"],
			groupName: "Editor",
		});
		const [lookup] = connect.requestsTo(`/connect/v1/organizations/${FAKE_ORG.id}`);
		const token = String(lookup?.headers.authorization).replace(/^Bearer /, "");
		expect(claims(token).aud).toBe("connect");
	});

	it("logs in the platform format with request and trace ids, and never a token, device code or user code", async () => {
		const connect = await startFake({ polls: ["pending", "slow_down"], resources: ["connect", "brain"] });
		const s = setup(connect);
		await signIn(s);
		await s.auth.getAccessToken("connect");
		await s.auth.getAccessToken("brain");
		await s.auth.logout();

		const text = readFileSync(join(agentDir, "veyra.log"), "utf-8");
		const records = text
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(records.length).toBeGreaterThanOrEqual(6);
		for (const record of records) {
			expect(record).toMatchObject({ service: "fingers", version: "0.1.0", env: "test" });
			expect(typeof record.time).toBe("string");
			expect(["debug", "info", "warn", "error"]).toContain(record.level);
			expect(typeof record.msg).toBe("string");
		}
		const requests = records.filter((record) => record.msg === "connect request");
		expect(requests.length).toBeGreaterThanOrEqual(6);
		for (const record of requests) {
			expect(record.request_id).toMatch(/^[0-9a-f-]{36}$/);
			expect(record.trace_id).toMatch(/^[0-9a-f]{32}$/);
			expect(record.span_id).toMatch(/^[0-9a-f]{16}$/);
		}
		expect(records.find((record) => record.msg === "signed in")).toMatchObject({
			actor_type: "person",
			actor_id: "usr_ada",
			org_id: FAKE_ORG.id,
		});
		expect(records.some((record) => record.msg === "signed out")).toBe(true);
		for (const secret of connect.issuedSecrets) expect(text).not.toContain(secret);
		expect(text).not.toContain("WDJB-MJHT");
	});
});
