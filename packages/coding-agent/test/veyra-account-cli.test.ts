/**
 * `fingers login`, `fingers whoami` and `fingers logout` against a fake Connect. The login screen follows the canvas
 * artboard FingersTuiLogin ("Fingers · CLI & web"); no output line ever holds a token.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runVeyraAccountCommand, type VeyraCliTerminal } from "../src/cli/veyra-account.ts";
import { VERSION } from "../src/config.ts";
import type { EeFeatureId, EeModule, VeyraTier } from "../src/core/edition/index.ts";
import { InMemorySecretStore } from "../src/core/os-keychain.ts";
import { openVeyraSessionVault } from "../src/core/veyra/session-vault.ts";
import { VeyraAuth } from "../src/core/veyra/veyra-auth.ts";
import { FakeConnect, type FakeConnectOptions } from "./veyra-fake-connect.ts";

let fake: FakeConnect | undefined;
let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "fingers-veyra-cli-"));
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

interface FakeTerminal extends VeyraCliTerminal {
	lines: string[];
	errors: string[];
	opened: string[];
	copied: string[];
	statuses: Array<string | undefined>;
	key?: (key: "copy" | "open" | "cancel") => void;
}

function terminal(options: { live?: boolean } = {}): FakeTerminal {
	const t: FakeTerminal = {
		interactive: true,
		lines: [],
		errors: [],
		opened: [],
		copied: [],
		statuses: [],
		write: (line) => t.lines.push(line),
		error: (line) => t.errors.push(line),
		openUrl: (url) => t.opened.push(url),
		copy: async (text) => {
			t.copied.push(text);
		},
	};
	if (options.live) {
		t.status = (line) => t.statuses.push(line);
		t.onKey = (handler) => {
			t.key = handler;
			return () => {
				t.key = undefined;
			};
		};
	}
	return t;
}

function makeAuth(
	connect: FakeConnect,
	options: { store?: InMemorySecretStore; env?: NodeJS.ProcessEnv; lockWaitMs?: number } = {},
) {
	const store = options.store ?? new InMemorySecretStore();
	let clock = Date.now();
	const auth = new VeyraAuth({
		issuer: connect.issuer,
		vault: openVeyraSessionVault({
			agentDir,
			issuer: connect.issuer,
			env: options.env ?? { FINGERS_CREDENTIAL_STORE: "keychain" },
			secretStore: store,
			lockWaitMs: options.lockWaitMs,
		}),
		apiUrl: connect.issuer,
		appVersion: "0.1.0",
		deviceName: "ada-mbp",
		userAgent: "fingers/0.1.0 (test)",
		now: () => clock,
		sleep: async (ms) => {
			clock += ms;
		},
	});
	return { auth, store };
}

/** A stand-in for the ee module (ee/ itself is not part of the core's tests). */
const MATRIX: Record<EeFeatureId, VeyraTier> = {
	token_saving: "low",
	subagents: "medium",
	checkpoints: "medium",
	brain: "medium",
	eyes: "medium",
	org_hooks: "high",
};
const EE_MODULE: EeModule = {
	apiVersion: 1,
	matrixVersion: "test.1",
	minimumTier: (feature) => MATRIX[feature],
	activate: () => {},
};

async function run(
	args: string[],
	auth: VeyraAuth,
	t: FakeTerminal,
	signal = new AbortController().signal,
	/** null: a core-only build. */
	ee: EeModule | null = EE_MODULE,
) {
	return runVeyraAccountCommand(args, {
		terminal: t,
		signal,
		openAuth: () => auth,
		loadEeModule: async () => ee ?? undefined,
	});
}

function expectNoSecrets(connect: FakeConnect, t: FakeTerminal): void {
	const text = [...t.lines, ...t.errors, ...t.statuses.map(String)].join("\n");
	for (const secret of connect.issuedSecrets) expect(text).not.toContain(secret);
}

/** Everything the command printed: lines, errors and live status lines. */
function printed(t: FakeTerminal): string[] {
	return [...t.lines, ...t.errors, ...t.statuses.filter((line): line is string => line !== undefined)];
}

/** OSC 52 (set the clipboard) and other escapes a hostile string could carry. */
const OSC52 = "\u001b]52;c;cm0gLXJmIH4K\u0007";
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Hold the sign-in's lock as another fingers process would, until the returned function runs. */
async function holdSignInLock(): Promise<() => Promise<void>> {
	const marker = readdirSync(agentDir).find((name) => name.startsWith("veyra-session.") && name.endsWith(".json"));
	if (!marker) throw new Error("no sign-in marker to lock");
	return lockfile.lock(join(agentDir, marker), { stale: 30_000 });
}

describe("fingers login", () => {
	it("shows the canvas login screen, opens the browser at the code's link, and ends signed in", async () => {
		const connect = await startFake({ polls: ["pending"] });
		const { auth } = makeAuth(connect);
		const t = terminal();
		expect(await run(["login"], auth, t)).toBe(0);
		expect(t.lines).toEqual([
			"Veyra Fingers",
			`v${VERSION} · Sign in with your Veyra account`,
			"",
			"Sign in to Veyra Connect to use your organization’s model connections and ee features.",
			"",
			`  1. Your browser opened ${connect.issuer}/device`,
			"  2. Check that it shows this code, then confirm:",
			"",
			"     WDJB-MJHT",
			"",
			"◐ Waiting for you to confirm in the browser · code expires in 10:00 · Ctrl+C cancels",
			"",
			"✓ Signed in as ada@example.com  ·  org Acme Robotics  ·  tier medium",
			"✓ ee features on: token saving · sub-agents · checkpoints · Brain · Eyes",
			"  Token stored in your OS keychain. Sign out with fingers logout or revoke the device in Connect.",
		]);
		expect(t.opened).toEqual([`${connect.issuer}/device?user_code=WDJB-MJHT`]);
		expect(t.errors).toEqual([]);
		expectNoSecrets(connect, t);
	});

	it("--no-browser asks the person to open the link and opens nothing", async () => {
		const connect = await startFake();
		const { auth } = makeAuth(connect);
		const t = terminal();
		expect(await run(["login", "--no-browser"], auth, t)).toBe(0);
		expect(t.lines).toContain(`  1. Open ${connect.issuer}/device in a browser`);
		expect(t.opened).toEqual([]);
	});

	it("where a browser would not reach the person (SSH, no display): shows the link and opens nothing", async () => {
		const connect = await startFake();
		const { auth } = makeAuth(connect);
		const t = terminal();
		t.canOpenUrl = false;
		expect(await run(["login"], auth, t)).toBe(0);
		expect(t.lines).toContain(`  1. Open ${connect.issuer}/device in a browser`);
		expect(t.lines.join("\n")).not.toContain("Your browser opened");
		expect(t.opened).toEqual([]);
	});

	it("in a terminal: a live countdown, c copies the code, o opens the link again", async () => {
		const connect = await startFake({ polls: ["pending", "pending"] });
		const { auth } = makeAuth(connect);
		const t = terminal({ live: true });
		const original = t.status!;
		t.status = (line) => {
			original(line);
			// Press the keys while the code is shown.
			if (t.statuses.length === 1) {
				t.key?.("copy");
				t.key?.("open");
			}
		};
		expect(await run(["login"], auth, t)).toBe(0);
		expect(t.lines).toContain("  c copy code · o open the link again · esc cancel");
		expect(t.statuses[0]).toBe("◐ Waiting for you to confirm in the browser   code expires in 10:00");
		expect(t.statuses.at(-1)).toBeUndefined();
		expect(t.copied).toEqual(["WDJB-MJHT"]);
		expect(t.opened).toEqual([
			`${connect.issuer}/device?user_code=WDJB-MJHT`,
			`${connect.issuer}/device?user_code=WDJB-MJHT`,
		]);
		expect(t.key).toBeUndefined();
	});

	it("esc cancels the sign-in", async () => {
		const connect = await startFake({ polls: Array(5).fill("pending") });
		const { auth } = makeAuth(connect);
		const t = terminal({ live: true });
		const original = t.status!;
		t.status = (line) => {
			original(line);
			if (t.statuses.length === 1) t.key?.("cancel");
		};
		expect(await run(["login"], auth, t)).toBe(1);
		expect(t.errors).toEqual(["Sign-in cancelled."]);
		expect(auth.account()).toBeUndefined();
	});

	it("access_denied: says the sign-in was denied in the browser", async () => {
		const connect = await startFake({ polls: ["denied"] });
		const { auth } = makeAuth(connect);
		const t = terminal();
		expect(await run(["login"], auth, t)).toBe(1);
		expect(t.errors).toEqual(["The sign-in was denied in the browser. Nothing was stored."]);
	});

	it("expired_token: says the code expired and to start again", async () => {
		const connect = await startFake({ polls: ["expired"] });
		const { auth } = makeAuth(connect);
		const t = terminal();
		expect(await run(["login"], auth, t)).toBe(1);
		expect(t.errors).toEqual(["The code expired before it was confirmed. Run fingers login again."]);
	});

	it("refuses when the OS keychain is not used: tokens are never kept anywhere else", async () => {
		const connect = await startFake();
		const { auth } = makeAuth(connect, { env: { FINGERS_CREDENTIAL_STORE: "file" } });
		const t = terminal();
		expect(await run(["login"], auth, t)).toBe(1);
		expect(t.errors.join("\n")).toContain("only in the OS keychain");
		expect(t.errors.join("\n")).toContain("FINGERS_CREDENTIAL_STORE=file");
		expect(connect.requests).toHaveLength(0);
	});

	it("rejects unknown options", async () => {
		const connect = await startFake();
		const { auth } = makeAuth(connect);
		const t = terminal();
		expect(await run(["login", "--bogus"], auth, t)).toBe(1);
		expect(t.errors[0]).toContain("Usage: fingers login");
	});
});

describe("fingers whoami", () => {
	it("prints the account, organization, tier, group and where the sign-in is stored", async () => {
		const connect = await startFake();
		const { auth } = makeAuth(connect);
		await run(["login"], auth, terminal());
		const t = terminal();
		expect(await run(["whoami"], auth, t)).toBe(0);
		expect(t.lines).toEqual([
			"Signed in as ada@example.com (Ada Lovelace)",
			"  Organization  Acme Robotics (acme)",
			"  Tier          medium",
			"  Group         Editor",
			"  ee            on · token saving · sub-agents · checkpoints · Brain · Eyes",
			`  Connect       ${connect.issuer}`,
			"  Stored in     in-memory keychain",
		]);
		expectNoSecrets(connect, t);
	});

	it("says core only, and why, when the tier, the app or the build has no ee", async () => {
		const connect = await startFake();
		const { auth } = makeAuth(connect);
		const login = terminal();
		connect.orgTier = "free";
		await run(["login"], auth, login);
		expect(login.lines).toContain("  Core only: the Free tier includes no ee features.");

		connect.orgTier = "medium";
		connect.orgApps = ["connect"];
		let t = terminal();
		await run(["whoami"], auth, t);
		expect(t.lines).toContain(
			"  ee            off · the Fingers app is off for Acme Robotics; an admin turns it on in Veyra Connect.",
		);

		connect.orgApps = ["connect", "fingers"];
		t = terminal();
		await run(["whoami"], auth, t, undefined, null);
		expect(t.lines).toContain("  ee            off · this Fingers build has no ee/ module.");
	});

	it("keeps ee as Connect last confirmed it while Connect is unreachable, and drops it when Connect refuses", async () => {
		const connect = await startFake();
		const { auth } = makeAuth(connect);
		await run(["login"], auth, terminal());
		connect.orgAnswer = { status: 503, body: { code: "unavailable" } };
		let t = terminal();
		await run(["whoami"], auth, t);
		expect(t.lines).toContain("  ee            on · token saving · sub-agents · checkpoints · Brain · Eyes");

		connect.orgAnswer = { status: 403, body: { code: "permission_denied", title: "Forbidden" } };
		t = terminal();
		await run(["whoami"], auth, t);
		expect(t.lines.find((line) => line.startsWith("  ee"))).toMatch(
			/^ {2}ee {12}off · Veyra Connect did not confirm/,
		);

		connect.orgAnswer = { status: 503, body: { code: "unavailable" } };
		t = terminal();
		await run(["whoami"], auth, t);
		expect(t.lines.find((line) => line.startsWith("  ee"))).toMatch(
			/^ {2}ee {12}off · Veyra Connect has not confirmed/,
		);
	});

	it("--json prints the same facts as JSON, without any token", async () => {
		const connect = await startFake();
		const { auth } = makeAuth(connect);
		await run(["login"], auth, terminal());
		const t = terminal();
		expect(await run(["whoami", "--json"], auth, t)).toBe(0);
		expect(JSON.parse(t.lines.join("\n"))).toEqual({
			signed_in: true,
			issuer: connect.issuer,
			subject: "usr_ada",
			email: "ada@example.com",
			name: "Ada Lovelace",
			organization: { id: "org_7aR2cT", code: "acme", name: "Acme Robotics", tier: "medium", group: "Editor" },
			ee: { on: true, features: ["token_saving", "subagents", "checkpoints", "brain", "eyes"] },
			storage: { persistent: true, location: "in-memory keychain" },
		});
		expectNoSecrets(connect, t);
	});

	it("not signed in: says so and exits 1", async () => {
		const connect = await startFake();
		const { auth } = makeAuth(connect);
		const t = terminal();
		expect(await run(["whoami"], auth, t)).toBe(1);
		expect(t.lines).toEqual(["Not signed in to Veyra. Run fingers login."]);
	});

	it("Connect unreachable: still prints what the keychain knows", async () => {
		const connect = await startFake();
		const { auth } = makeAuth(connect);
		await run(["login"], auth, terminal());
		await connect.stop();
		const t = terminal();
		expect(await run(["whoami"], auth, t)).toBe(0);
		expect(t.lines[0]).toBe("Signed in as ada@example.com (Ada Lovelace)");
		expect(t.lines[1]).toMatch(
			/^ {2}Organization {2}Acme Robotics \(acme\) · not checked now: Connect could not be reached/,
		);
		expect(t.lines).toContain("  Tier          medium");
	});
});

describe("fingers logout", () => {
	it("revokes the device at Connect and removes the sign-in from the keychain", async () => {
		const connect = await startFake();
		const { auth, store } = makeAuth(connect);
		await run(["login"], auth, terminal());
		const t = terminal();
		expect(await run(["logout"], auth, t)).toBe(0);
		expect(t.lines).toEqual([
			"Signed out of Veyra. Connect revoked this device, and the sign-in is gone from your OS keychain.",
		]);
		expect([...store.items.keys()]).toEqual([]);
	});

	it("without revocation at Connect: signed out here, and where to remove the device", async () => {
		const connect = await startFake({ revocation: false });
		const { auth } = makeAuth(connect);
		await run(["login"], auth, terminal());
		const t = terminal();
		expect(await run(["logout"], auth, t)).toBe(0);
		expect(t.lines).toEqual([
			"Signed out of Veyra on this computer. Connect can't revoke the device from here yet, so it still lists it:",
			`remove it under Connected apps, ${connect.issuer}/account/apps`,
		]);
	});

	it("Connect unreachable: signed out here, exit 1, and where to remove the device", async () => {
		const connect = await startFake();
		const { auth } = makeAuth(connect);
		await run(["login"], auth, terminal());
		await connect.stop();
		const t = terminal();
		expect(await run(["logout"], auth, t)).toBe(1);
		expect(t.errors[0]).toMatch(/^Signed out of Veyra on this computer, but Connect could not revoke the device/);
		expect(t.errors[1]).toBe(`Remove it under Connected apps, ${connect.issuer}/account/apps`);
	});

	it("not signed in: says so and exits 0", async () => {
		const connect = await startFake();
		const { auth } = makeAuth(connect);
		const t = terminal();
		expect(await run(["logout"], auth, t)).toBe(0);
		expect(t.lines).toEqual(["Not signed in to Veyra."]);
	});

	it("a sign-out the keychain refuses is reported with exit 1, not thrown", async () => {
		const refusing = {
			issuer: "https://connect.veyra.so",
			logout: async () => {
				throw new Error("The macOS Keychain refused the change");
			},
		} as unknown as VeyraAuth;
		const t = terminal();
		expect(await run(["logout"], refusing, t)).toBe(1);
		expect(t.errors).toEqual(["Could not sign out of Veyra: The macOS Keychain refused the change"]);
	});
});

describe("fingers login: the verification link must be on Connect's own origin", () => {
	const foreign = "https://connect.example.net";
	it.each([
		{
			name: "a foreign host in verification_uri",
			options: { verificationUriOverride: `${foreign}/device` },
			value: foreign,
		},
		{
			name: "a foreign host in verification_uri_complete",
			options: { verificationUriCompleteOverride: `${foreign}/device?user_code=WDJB-MJHT` },
			value: foreign,
		},
		{
			name: "a javascript: verification_uri",
			options: { verificationUriOverride: "javascript:alert(document.domain)" },
			value: "javascript:alert",
		},
		{
			name: "a file: verification_uri_complete",
			options: { verificationUriCompleteOverride: "file:///etc/passwd" },
			value: "file:///etc/passwd",
		},
	])("$name: opens nothing, shows no link or code, and sends no token poll", async ({ options, value }) => {
		const connect = await startFake(options);
		const { auth } = makeAuth(connect);
		const t = terminal({ live: true });
		expect(await run(["login"], auth, t)).toBe(1);

		expect(t.opened).toEqual([]);
		const shown = printed(t).join("\n");
		expect(shown).not.toContain(value);
		expect(shown).not.toContain("WDJB-MJHT");
		expect(shown).not.toMatch(/Your browser opened|1\. Open /);
		expect(t.errors.join("\n")).toContain("verification address");
		expect(connect.requestsTo("/oauth2/device_authorization")).toHaveLength(1);
		expect(connect.requestsTo("/oauth2/token")).toHaveLength(0);
		expect(auth.account()).toBeUndefined();
	});
});

describe("strings from Connect are printed without terminal escapes", () => {
	it("an OSC 52 / ESC sequence in the organization, tier, group, name and email is neutralized in login and whoami", async () => {
		const connect = await startFake({
			orgOverride: { name: `${OSC52}Acme\u001b[2J Robotics`, code: "acme\u001b[1A", tier: "medium\u0007" },
			groupNameOverride: `Editor${OSC52}`,
			idTokenClaimsOverride: { name: "Ada\u001b]0;owned\u0007 Lovelace", email: `ada${OSC52}@example.com` },
		});
		const { auth } = makeAuth(connect);
		const login = terminal();
		expect(await run(["login"], auth, login)).toBe(0);
		const whoami = terminal();
		expect(await run(["whoami"], auth, whoami)).toBe(0);

		for (const line of [...printed(login), ...printed(whoami)]) expect(line).not.toMatch(CONTROL);
		const summary = login.lines.find((line) => line.startsWith("✓ Signed in as"));
		expect(summary).toContain("Acme");
		expect(summary).toContain("Robotics");
		expect(summary).toContain("@example.com");
		expect(whoami.lines.join("\n")).toContain("Editor");
		expect(whoami.lines.join("\n")).toContain("Lovelace");
	});

	it("an OSC 52 / ESC sequence in Connect's error_description is neutralized in the error", async () => {
		const connect = await startFake({
			startError: { status: 400, error: "invalid_request", description: `Bad request${OSC52}\u001b[2J` },
		});
		const { auth } = makeAuth(connect);
		const t = terminal();
		expect(await run(["login"], auth, t)).toBe(1);
		expect(t.errors.join("\n")).toContain("Bad request");
		for (const line of printed(t)) expect(line).not.toMatch(CONTROL);
	});
});

describe("fingers logout when another fingers process holds the lock", () => {
	it("reports the lock, still revokes the device and clears the keychain", async () => {
		const connect = await startFake();
		const { auth, store } = makeAuth(connect, { lockWaitMs: 300 });
		await run(["login"], auth, terminal());
		const release = await holdSignInLock();
		try {
			const t = terminal();
			expect(await run(["logout"], auth, t)).toBe(0);
			expect(t.errors.join("\n")).toMatch(/lock/i);
			expect(t.lines).toEqual([
				"Signed out of Veyra. Connect revoked this device, and the sign-in is gone from your OS keychain.",
			]);
			expect(connect.revoked).toHaveLength(1);
			expect([...store.items.keys()]).toEqual([]);
			expect(auth.account()).toBeUndefined();
		} finally {
			await release();
		}
	});
});

describe("round 2 of the review", () => {
	it("whoami --json escapes C1 and bidi controls (U+009D OSC, U+009B CSI, U+202E) and keeps the exact values", async () => {
		const orgName = "Acme\u009d52;c;cm0gLXJmIH4K\u009c \u202eRobotics";
		const groupName = "Editor\u009b2J";
		const connect = await startFake({ orgOverride: { name: orgName }, groupNameOverride: groupName });
		const { auth } = makeAuth(connect);
		await run(["login"], auth, terminal());
		const t = terminal();
		expect(await run(["whoami", "--json"], auth, t)).toBe(0);
		const text = t.lines.join("\n");
		expect(text).not.toMatch(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
		const parsed = JSON.parse(text) as { organization: { name: string; group: string } };
		expect(parsed.organization.name).toBe(orgName);
		expect(parsed.organization.group).toBe(groupName);
	});

	it("bidi controls from Connect (U+202E, U+2066-U+2069) are neutralized in login and whoami", async () => {
		const connect = await startFake({
			orgOverride: { name: "Acme \u202escitoboR\u202c" },
			groupNameOverride: "\u2066Editor\u2069",
			idTokenClaimsOverride: { name: "Ada \u2067Lovelace\u2069" },
		});
		const { auth } = makeAuth(connect);
		const login = terminal();
		expect(await run(["login"], auth, login)).toBe(0);
		const whoami = terminal();
		expect(await run(["whoami"], auth, whoami)).toBe(0);
		for (const line of [...printed(login), ...printed(whoami)]) {
			expect(line).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
		}
		expect(whoami.lines.join("\n")).toContain("Editor");
	});

	it("a lock wait longer than the revoke timeout still sends the revoke (the timeout starts at the revoke)", async () => {
		const connect = await startFake();
		const { auth, store } = makeAuth(connect, { lockWaitMs: 600 });
		await run(["login"], auth, terminal());
		const release = await holdSignInLock();
		try {
			const t = terminal();
			const code = await runVeyraAccountCommand(["logout"], {
				terminal: t,
				signal: new AbortController().signal,
				openAuth: () => auth,
				revokeTimeoutMs: 300,
			});
			expect(code).toBe(0);
			expect(connect.revoked).toHaveLength(1);
			expect(t.lines).toEqual([
				"Signed out of Veyra. Connect revoked this device, and the sign-in is gone from your OS keychain.",
			]);
			expect([...store.items.keys()]).toEqual([]);
		} finally {
			await release();
		}
	});

	it("an ESC sequence in a failed revocation's error_description is neutralized", async () => {
		const connect = await startFake({
			revokeError: { status: 400, error: "invalid_request", description: `Bad token${OSC52}\u001b[2J` },
		});
		const { auth } = makeAuth(connect);
		await run(["login"], auth, terminal());
		const t = terminal();
		expect(await run(["logout"], auth, t)).toBe(1);
		expect(t.errors[0]).toContain("Connect could not revoke the device (invalid_request: Bad token");
		for (const line of printed(t)) expect(line).not.toMatch(CONTROL);
	});

	it("an ESC sequence in a sign-in error that is not a device-flow error is neutralized", async () => {
		const failing = {
			issuer: "https://connect.veyra.so",
			storage: { persistent: true, location: "in-memory keychain" },
			login: async () => {
				throw new Error(`The keychain refused the sign-in${OSC52}\u001b[2J`);
			},
		} as unknown as VeyraAuth;
		const t = terminal();
		expect(await run(["login"], failing, t)).toBe(1);
		expect(t.errors[0]).toMatch(/^Could not sign in: The keychain refused the sign-in/);
		for (const line of printed(t)) expect(line).not.toMatch(CONTROL);
	});

	it("the browser launcher fails: asks to open the link and never says the browser opened", async () => {
		const connect = await startFake();
		const { auth } = makeAuth(connect);
		const t = terminal();
		t.launchUrl = async (url) => {
			t.opened.push(url);
			return false;
		};
		expect(await run(["login"], auth, t)).toBe(0);
		expect(t.opened).toEqual([`${connect.issuer}/device?user_code=WDJB-MJHT`]);
		expect(t.lines).toContain(`  1. Open ${connect.issuer}/device in a browser`);
		expect(t.lines.join("\n")).not.toContain("Your browser opened");
		expect(t.lines).toContain("     WDJB-MJHT");
	});

	it("the browser launcher starts: says the browser opened", async () => {
		const connect = await startFake();
		const { auth } = makeAuth(connect);
		const t = terminal();
		t.launchUrl = async (url) => {
			t.opened.push(url);
			return true;
		};
		expect(await run(["login"], auth, t)).toBe(0);
		expect(t.lines).toContain(`  1. Your browser opened ${connect.issuer}/device`);
	});
});
