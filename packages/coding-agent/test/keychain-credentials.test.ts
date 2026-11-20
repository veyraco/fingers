import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	KeychainBlob,
	keychainAccountFor,
	keychainMarkerPath,
	openCredentialStorage,
	openReadOnlyCredentialStorage,
} from "../src/core/keychain-auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	type CommandResult,
	type CommandRunner,
	InMemorySecretStore,
	LinuxSecretService,
	MacOsKeychain,
	type SecretStore,
	WindowsCredentialManager,
} from "../src/core/os-keychain.ts";

const SECRET = "sk-ant-api03-very-secret-key-0123456789";

interface Call {
	command: string;
	args: readonly string[];
	input?: string;
}

/** Fake command runner that records calls and answers from a script. */
function fakeRunner(answer: (call: Call) => Partial<CommandResult>): { run: CommandRunner; calls: Call[] } {
	const calls: Call[] = [];
	const run: CommandRunner = (command, args, input) => {
		const call = { command, args, input };
		calls.push(call);
		return { status: 0, stdout: "", stderr: "", ...answer(call) };
	};
	return { run, calls };
}

/** Every file under a directory, recursively, as text. */
function filesUnder(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf-8"));
}

describe("platform keychains (fake command runner)", () => {
	test("macOS writes through `security -i` on stdin, so the secret is never in argv", () => {
		const { run, calls } = fakeRunner(() => ({}));
		const store = new MacOsKeychain({ run });
		store.set("auth:abc", "c2VjcmV0");
		expect(calls).toHaveLength(1);
		expect(calls[0].command).toBe("security");
		expect(calls[0].args).toEqual(["-i"]);
		expect(calls[0].input).toContain('add-generic-password -U -s "Veyra Fingers" -a "auth:abc"');
		expect(calls[0].input).toContain('-w "c2VjcmV0"');
		expect(calls.flatMap((call) => call.args).join(" ")).not.toContain("c2VjcmV0");
	});

	test("macOS read maps errSecItemNotFound (44) to absent and other failures to errors", () => {
		const missing = new MacOsKeychain({ run: fakeRunner(() => ({ status: 44 })).run });
		expect(missing.get("auth:abc")).toBeUndefined();
		const found = new MacOsKeychain({ run: fakeRunner(() => ({ stdout: "dmFsdWU=\n" })).run });
		expect(found.get("auth:abc")).toBe("dmFsdWU=");
		const broken = new MacOsKeychain({
			run: fakeRunner(() => ({ status: 51, stderr: "user interaction not allowed" })).run,
		});
		expect(() => broken.get("auth:abc")).toThrow(/macOS Keychain: read failed: user interaction not allowed/);
		const failedWrite = new MacOsKeychain({
			run: fakeRunner(() => ({ status: 0, stderr: "security: SecKeychainItemCreateFromContent: error" })).run,
		});
		expect(() => failedWrite.set("auth:abc", "dmFsdWU=")).toThrow(/write failed/);
	});

	test("Linux stores through secret-tool with the secret on stdin", () => {
		const { run, calls } = fakeRunner(() => ({}));
		const store = new LinuxSecretService({ run });
		store.set("auth:abc", "c2VjcmV0");
		expect(calls[0].command).toBe("secret-tool");
		expect(calls[0].args).toEqual([
			"store",
			"--label=Veyra Fingers (auth:abc)",
			"service",
			"Veyra Fingers",
			"account",
			"auth:abc",
		]);
		expect(calls[0].input).toBe("c2VjcmV0");
	});

	test("Linux is unavailable without secret-tool or a reachable Secret Service", () => {
		const noTool = new LinuxSecretService({
			run: fakeRunner(() => ({ status: null, error: new Error("spawn ENOENT") })).run,
		});
		expect(noTool.available()).toBe(false);
		const noDbus = new LinuxSecretService({
			run: fakeRunner(() => ({ status: 1, stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY" })).run,
		});
		expect(noDbus.available()).toBe(false);
		const ok = new LinuxSecretService({ run: fakeRunner(() => ({ status: 1 })).run });
		expect(ok.available()).toBe(true);
		expect(ok.get("auth:abc")).toBeUndefined();
	});

	test("Windows sends the secret to PowerShell in the stdin request only", () => {
		const { run, calls } = fakeRunner((call) => (call.input?.includes('"op":"get"') ? { status: 3 } : {}));
		const store = new WindowsCredentialManager({ run });
		store.set("auth:abc", "c2VjcmV0");
		expect(calls[0].command).toBe("powershell.exe");
		expect(calls[0].args.join(" ")).not.toContain("c2VjcmV0");
		expect(JSON.parse(calls[0].input ?? "{}")).toEqual({
			op: "set",
			target: "Veyra Fingers/auth:abc",
			value: "c2VjcmV0",
		});
		expect(store.get("auth:abc")).toBeUndefined();
	});

	test("stores refuse values that could break out of the command line", () => {
		const store = new MacOsKeychain({ run: fakeRunner(() => ({})).run });
		expect(() => store.set("auth:abc", 'x" -A')).toThrow(/characters/);
		expect(() => store.set("auth abc", "x")).toThrow(/account/);
	});
});

describe("KeychainBlob", () => {
	test("splits a long value into chunks and reads it back", () => {
		const store = new InMemorySecretStore({ maxValueLength: 128 });
		const blob = new KeychainBlob(store, "auth:test");
		const text = JSON.stringify({ anthropic: { type: "api_key", key: SECRET.repeat(10) }, note: "çok güzel ✓" });
		blob.write(text);
		expect(store.items.size).toBeGreaterThan(3);
		expect(blob.read()).toBe(text);
		for (const value of store.items.values()) expect(value.length).toBeLessThanOrEqual(128);
	});

	test("a shorter write removes the chunks it no longer needs", () => {
		const store = new InMemorySecretStore({ maxValueLength: 128 });
		const blob = new KeychainBlob(store, "auth:test");
		blob.write("x".repeat(1000));
		const before = store.items.size;
		blob.write("{}");
		expect(store.items.size).toBeLessThan(before);
		expect(blob.read()).toBe("{}");
		blob.delete();
		expect(store.items.size).toBe(0);
		expect(blob.read()).toBeUndefined();
	});

	test("a damaged chunk is detected by the checksum", () => {
		const store = new InMemorySecretStore({ maxValueLength: 128 });
		const blob = new KeychainBlob(store, "auth:test");
		blob.write(JSON.stringify({ a: 1, b: "two" }));
		store.items.set("auth:test#1", "AAAAAAAA");
		expect(() => blob.read()).toThrow(/checksum/);
	});
});

describe("credential storage in the OS keychain", () => {
	let dir: string;
	let authPath: string;

	beforeEach(() => {
		dir = join(tmpdir(), `fingers-keychain-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		authPath = join(dir, "auth.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const keychainEnv = { FINGERS_CREDENTIAL_STORE: "keychain" };

	test("a saved key goes to the keychain; no file in the agent directory holds it", async () => {
		const store = new InMemorySecretStore();
		const { storage, info } = openCredentialStorage({ authPath, env: keychainEnv, secretStore: store });
		expect(info).toEqual({ kind: "os-keychain", location: "in-memory keychain", migratedProviders: [] });
		await storage.modify("anthropic", async () => ({ type: "api_key", key: SECRET }));

		expect(existsSync(authPath)).toBe(false);
		for (const text of filesUnder(dir)) expect(text).not.toContain(SECRET);
		const marker = JSON.parse(readFileSync(keychainMarkerPath(authPath), "utf-8"));
		expect(marker).toMatchObject({ store: "os-keychain", account: keychainAccountFor(authPath) });
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: SECRET });
	});

	test("a second process sees a key another process saved", async () => {
		const store = new InMemorySecretStore();
		const first = openCredentialStorage({ authPath, env: keychainEnv, secretStore: store }).storage;
		const second = openCredentialStorage({ authPath, env: keychainEnv, secretStore: store }).storage;
		expect(await second.read("openai")).toBeUndefined();
		await first.modify("openai", async () => ({ type: "api_key", key: "sk-openai" }));
		expect(await second.read("openai")).toEqual({ type: "api_key", key: "sk-openai" });
		await second.delete("openai");
		expect(await first.read("openai")).toBeUndefined();
	});

	test("an existing plaintext auth.json is moved into the keychain and deleted", async () => {
		const plaintext = {
			anthropic: { type: "api_key", key: SECRET },
			"openai-codex": {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: 1_900_000_000_000,
			},
		};
		writeFileSync(authPath, JSON.stringify(plaintext, null, 2), { mode: 0o600 });
		const store = new InMemorySecretStore();

		const { storage, info } = openCredentialStorage({ authPath, env: keychainEnv, secretStore: store });

		expect(info.kind).toBe("os-keychain");
		expect(info.migratedProviders.sort()).toEqual(["anthropic", "openai-codex"]);
		expect(existsSync(authPath)).toBe(false);
		for (const text of filesUnder(dir)) expect(text).not.toContain(SECRET);
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: SECRET });
		expect(await storage.read("openai-codex")).toMatchObject({ type: "oauth", refresh: "refresh-token" });
		expect(JSON.parse(new KeychainBlob(store, keychainAccountFor(authPath)).read() ?? "{}")).toEqual(plaintext);
	});

	test("keychain entries win over a stale auth.json during the move", async () => {
		const store = new InMemorySecretStore();
		new KeychainBlob(store, keychainAccountFor(authPath)).write(
			JSON.stringify({ anthropic: { type: "api_key", key: "newer-key" } }),
		);
		writeFileSync(
			authPath,
			JSON.stringify({ anthropic: { type: "api_key", key: "older-key" }, xai: { type: "api_key", key: "xai-key" } }),
		);
		const { storage, info } = openCredentialStorage({ authPath, env: keychainEnv, secretStore: store });
		expect(info.migratedProviders).toEqual(["xai"]);
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "newer-key" });
		expect(await storage.read("xai")).toEqual({ type: "api_key", key: "xai-key" });
		expect(existsSync(authPath)).toBe(false);
	});

	test("when the keychain write fails, auth.json is kept and used", async () => {
		writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: SECRET } }));
		const failing: SecretStore = Object.assign(new InMemorySecretStore(), {
			set: () => {
				throw new Error("locked");
			},
		});
		const { storage, info } = openCredentialStorage({ authPath, env: keychainEnv, secretStore: failing });
		expect(info.kind).toBe("file");
		expect(info.fallbackReason).toMatch(/locked/);
		expect(existsSync(authPath)).toBe(true);
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: SECRET });
	});

	test("FINGERS_CREDENTIAL_STORE=file and an unreachable keychain keep auth.json", () => {
		const store = new InMemorySecretStore();
		expect(
			openCredentialStorage({ authPath, env: { FINGERS_CREDENTIAL_STORE: "file" }, secretStore: store }).info,
		).toEqual({
			kind: "file",
			location: authPath,
			migratedProviders: [],
			fallbackReason: undefined,
		});
		const unreachable = new InMemorySecretStore({ available: false });
		expect(openCredentialStorage({ authPath, env: keychainEnv, secretStore: unreachable }).info).toMatchObject({
			kind: "file",
			fallbackReason: "in-memory keychain is not reachable",
		});
		expect(() => openCredentialStorage({ authPath, env: { FINGERS_CREDENTIAL_STORE: "vault" } })).toThrow(
			/keychain" or "file/,
		);
	});

	test("the read-only view reads the keychain and writes nothing", async () => {
		const store = new InMemorySecretStore();
		new KeychainBlob(store, keychainAccountFor(authPath)).write(
			JSON.stringify({ xai: { type: "api_key", key: "k" } }),
		);
		const readOnly = openReadOnlyCredentialStorage({ authPath, env: keychainEnv, secretStore: store });
		expect(await readOnly.read("xai")).toEqual({ type: "api_key", key: "k" });
		await expect(readOnly.modify("xai", async () => undefined)).rejects.toThrow(/Read-only/);
		expect(existsSync(keychainMarkerPath(authPath))).toBe(false);
	});

	test("the model runtime reports where credentials live", async () => {
		const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
		// Tests run with FINGERS_CREDENTIAL_STORE=file (vitest config) so they never touch a real keychain.
		expect(runtime.credentialStorage).toMatchObject({ kind: "file", location: authPath });
	});
});
