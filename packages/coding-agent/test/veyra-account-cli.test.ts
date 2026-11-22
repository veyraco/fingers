/**
 * `fingers login`, `fingers whoami` and `fingers logout` against a fake Connect. The login screen follows the canvas
 * artboard FingersTuiLogin ("Fingers · CLI & web"); no output line ever holds a token.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runVeyraAccountCommand, type VeyraCliTerminal } from "../src/cli/veyra-account.ts";
import { VERSION } from "../src/config.ts";
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

function makeAuth(connect: FakeConnect, options: { store?: InMemorySecretStore; env?: NodeJS.ProcessEnv } = {}) {
	const store = options.store ?? new InMemorySecretStore();
	let clock = Date.now();
	const auth = new VeyraAuth({
		issuer: connect.issuer,
		vault: openVeyraSessionVault({
			agentDir,
			issuer: connect.issuer,
			env: options.env ?? { FINGERS_CREDENTIAL_STORE: "keychain" },
			secretStore: store,
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

async function run(args: string[], auth: VeyraAuth, t: FakeTerminal, signal = new AbortController().signal) {
	return runVeyraAccountCommand(args, { terminal: t, signal, openAuth: () => auth });
}

function expectNoSecrets(connect: FakeConnect, t: FakeTerminal): void {
	const text = [...t.lines, ...t.errors, ...t.statuses.map(String)].join("\n");
	for (const secret of connect.issuedSecrets) expect(text).not.toContain(secret);
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
			"✓ Signed in as ada@acme.dev  ·  org Acme Robotics  ·  tier medium",
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
			"Signed in as ada@acme.dev (Ada Lovelace)",
			"  Organization  Acme Robotics (acme)",
			"  Tier          medium",
			"  Group         Editor",
			`  Connect       ${connect.issuer}`,
			"  Stored in     in-memory keychain",
		]);
		expectNoSecrets(connect, t);
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
			email: "ada@acme.dev",
			name: "Ada Lovelace",
			organization: { id: "org_7aR2cT", code: "acme", name: "Acme Robotics", tier: "medium", group: "Editor" },
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
		expect(t.lines[0]).toBe("Signed in as ada@acme.dev (Ada Lovelace)");
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
});
