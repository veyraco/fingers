/**
 * OS keychain access through the platform's own command-line tools, so Fingers needs no native module:
 * - macOS: `security` (login keychain). Values go in through `security -i` on stdin, never argv.
 * - Linux: `secret-tool` (libsecret / Secret Service). Values go in on stdin.
 * - Windows: Credential Manager through PowerShell (CredRead/CredWrite). Values go in on stdin.
 *
 * A secret never appears in a process argument list, where other local users could read it.
 */

import { spawnSync } from "node:child_process";

export const KEYCHAIN_SERVICE = "Veyra Fingers";

/** One stored secret per account inside the Fingers service. */
export interface SecretStore {
	/** Short name for messages, e.g. "macOS Keychain". */
	readonly name: string;
	/** Whether the store can be used on this machine (tool installed, service reachable). */
	available(): boolean;
	get(account: string): string | undefined;
	set(account: string, value: string): void;
	delete(account: string): void;
	/**
	 * Longest value `set` accepts. Longer data is split by the caller (see KeychainBlob).
	 * Windows Credential Manager limits a blob to 2560 bytes; the others are set to the same order
	 * so every platform exercises the same chunked layout. At least 128, so a chunk head fits.
	 */
	readonly maxValueLength: number;
}

export interface CommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
}

/** Runs a command with stdin input. Tests replace it with a fake. */
export type CommandRunner = (command: string, args: readonly string[], input?: string) => CommandResult;

export const runCommand: CommandRunner = (command, args, input) => {
	const result = spawnSync(command, [...args], {
		input: input ?? "",
		encoding: "utf-8",
		windowsHide: true,
		timeout: 15_000,
		maxBuffer: 4 * 1024 * 1024,
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		error: result.error,
	};
};

export class KeychainError extends Error {
	constructor(store: string, operation: string, detail: string) {
		super(`${store}: ${operation} failed${detail ? `: ${detail.trim()}` : ""}`);
		this.name = "KeychainError";
	}
}

/** Values the stores accept: base64 and the small JSON head, so quoting is never an issue. */
const SAFE_VALUE = /^[A-Za-z0-9+/=:._-]*$/;
const SAFE_ACCOUNT = /^[A-Za-z0-9#:._/-]+$/;

function checkAccount(account: string): void {
	if (!SAFE_ACCOUNT.test(account)) throw new Error(`Invalid keychain account name: ${account}`);
}

function checkValue(store: SecretStore, value: string): void {
	if (!SAFE_VALUE.test(value)) throw new Error(`${store.name}: value has characters the store does not take`);
	if (value.length > store.maxValueLength) {
		throw new Error(`${store.name}: value longer than ${store.maxValueLength} characters`);
	}
}

/** macOS login keychain through /usr/bin/security. */
export class MacOsKeychain implements SecretStore {
	readonly name = "macOS Keychain";
	readonly maxValueLength = 1800;
	private readonly run: CommandRunner;
	private readonly service: string;

	constructor(options: { run?: CommandRunner; service?: string } = {}) {
		this.run = options.run ?? runCommand;
		this.service = options.service ?? KEYCHAIN_SERVICE;
	}

	available(): boolean {
		const result = this.run("security", ["list-keychains", "-d", "user"]);
		return !result.error && result.status === 0;
	}

	get(account: string): string | undefined {
		checkAccount(account);
		const result = this.run("security", ["find-generic-password", "-s", this.service, "-a", account, "-w"]);
		if (result.error) throw new KeychainError(this.name, "read", result.error.message);
		// 44 = errSecItemNotFound
		if (result.status === 44) return undefined;
		if (result.status !== 0) throw new KeychainError(this.name, "read", result.stderr);
		return result.stdout.replace(/\r?\n$/, "");
	}

	set(account: string, value: string): void {
		checkAccount(account);
		checkValue(this, value);
		// `security -i` reads the command from stdin, so the value never reaches argv.
		const command = `add-generic-password -U -s "${this.service}" -a "${account}" -l "${this.service}" -w "${value}"\n`;
		const result = this.run("security", ["-i"], command);
		if (result.error) throw new KeychainError(this.name, "write", result.error.message);
		if (result.status !== 0 || /error/i.test(result.stderr)) {
			throw new KeychainError(this.name, "write", result.stderr);
		}
	}

	delete(account: string): void {
		checkAccount(account);
		const result = this.run("security", ["delete-generic-password", "-s", this.service, "-a", account]);
		if (result.error) throw new KeychainError(this.name, "delete", result.error.message);
		if (result.status !== 0 && result.status !== 44) throw new KeychainError(this.name, "delete", result.stderr);
	}
}

/** Linux Secret Service (GNOME Keyring, KWallet) through secret-tool from libsecret. */
export class LinuxSecretService implements SecretStore {
	readonly name = "Secret Service";
	readonly maxValueLength = 1800;
	private readonly run: CommandRunner;
	private readonly service: string;

	constructor(options: { run?: CommandRunner; service?: string } = {}) {
		this.run = options.run ?? runCommand;
		this.service = options.service ?? KEYCHAIN_SERVICE;
	}

	private attributes(account: string): string[] {
		return ["service", this.service, "account", account];
	}

	available(): boolean {
		// A lookup of an absent item exits 1 silently; a missing tool or an unreachable D-Bus
		// service fails to spawn or writes an error.
		const result = this.run("secret-tool", ["lookup", ...this.attributes("fingers-probe")]);
		if (result.error) return false;
		return (result.status === 0 || result.status === 1) && result.stderr.trim() === "";
	}

	get(account: string): string | undefined {
		checkAccount(account);
		const result = this.run("secret-tool", ["lookup", ...this.attributes(account)]);
		if (result.error) throw new KeychainError(this.name, "read", result.error.message);
		if (result.status === 1 && result.stderr.trim() === "") return undefined;
		if (result.status !== 0) throw new KeychainError(this.name, "read", result.stderr);
		return result.stdout.replace(/\r?\n$/, "");
	}

	set(account: string, value: string): void {
		checkAccount(account);
		checkValue(this, value);
		const result = this.run(
			"secret-tool",
			["store", `--label=${this.service} (${account})`, ...this.attributes(account)],
			value,
		);
		if (result.error) throw new KeychainError(this.name, "write", result.error.message);
		if (result.status !== 0) throw new KeychainError(this.name, "write", result.stderr);
	}

	delete(account: string): void {
		checkAccount(account);
		const result = this.run("secret-tool", ["clear", ...this.attributes(account)]);
		if (result.error) throw new KeychainError(this.name, "delete", result.error.message);
		// clear exits 1 when nothing matched
		if (result.status !== 0 && !(result.status === 1 && result.stderr.trim() === "")) {
			throw new KeychainError(this.name, "delete", result.stderr);
		}
	}
}

// PowerShell program for Windows Credential Manager. It reads one JSON request from stdin:
// {"op":"get"|"set"|"delete"|"probe","target":"...","value":"..."} and answers on stdout.
const WINDOWS_CREDENTIAL_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FingersCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr cred);
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) { if (Marshal.GetLastWin32Error() == 1168) return null; throw new Exception("CredRead " + Marshal.GetLastWin32Error()); }
    try { var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); var b = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, b, 0, b.Length); return Encoding.UTF8.GetString(b); }
    finally { CredFree(p); }
  }
  public static void Write(string target, string value) {
    var b = Encoding.UTF8.GetBytes(value); var h = Marshal.AllocHGlobal(b.Length);
    try { Marshal.Copy(b, 0, h, b.Length); var c = new CREDENTIAL { Type = 1, TargetName = target, CredentialBlobSize = b.Length, CredentialBlob = h, Persist = 2, UserName = "fingers" };
      if (!CredWriteW(ref c, 0)) throw new Exception("CredWrite " + Marshal.GetLastWin32Error()); }
    finally { Marshal.FreeHGlobal(h); }
  }
  public static void Delete(string target) {
    if (!CredDeleteW(target, 1, 0) && Marshal.GetLastWin32Error() != 1168) throw new Exception("CredDelete " + Marshal.GetLastWin32Error());
  }
}
'@
$req = [Console]::In.ReadToEnd() | ConvertFrom-Json
switch ($req.op) {
  'probe' { [Console]::Out.Write('ok') }
  'get' { $v = [FingersCred]::Read($req.target); if ($null -eq $v) { exit 3 } ; [Console]::Out.Write($v) }
  'set' { [FingersCred]::Write($req.target, $req.value) }
  'delete' { [FingersCred]::Delete($req.target) }
}
`;

/** Windows Credential Manager (generic credentials) through PowerShell. */
export class WindowsCredentialManager implements SecretStore {
	readonly name = "Windows Credential Manager";
	// CRED_MAX_CREDENTIAL_BLOB_SIZE is 2560 bytes; values are ASCII.
	readonly maxValueLength = 1800;
	private readonly run: CommandRunner;
	private readonly service: string;

	constructor(options: { run?: CommandRunner; service?: string } = {}) {
		this.run = options.run ?? runCommand;
		this.service = options.service ?? KEYCHAIN_SERVICE;
	}

	private call(request: Record<string, string>): CommandResult {
		return this.run(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_CREDENTIAL_SCRIPT],
			JSON.stringify(request),
		);
	}

	private target(account: string): string {
		return `${this.service}/${account}`;
	}

	available(): boolean {
		const result = this.call({ op: "probe" });
		return !result.error && result.status === 0 && result.stdout === "ok";
	}

	get(account: string): string | undefined {
		checkAccount(account);
		const result = this.call({ op: "get", target: this.target(account) });
		if (result.error) throw new KeychainError(this.name, "read", result.error.message);
		if (result.status === 3) return undefined;
		if (result.status !== 0) throw new KeychainError(this.name, "read", result.stderr);
		return result.stdout;
	}

	set(account: string, value: string): void {
		checkAccount(account);
		checkValue(this, value);
		const result = this.call({ op: "set", target: this.target(account), value });
		if (result.error) throw new KeychainError(this.name, "write", result.error.message);
		if (result.status !== 0) throw new KeychainError(this.name, "write", result.stderr);
	}

	delete(account: string): void {
		checkAccount(account);
		const result = this.call({ op: "delete", target: this.target(account) });
		if (result.error) throw new KeychainError(this.name, "delete", result.error.message);
		if (result.status !== 0) throw new KeychainError(this.name, "delete", result.stderr);
	}
}

/** The keychain of this platform, or undefined when the platform has none Fingers can use. */
export function platformSecretStore(
	platform: NodeJS.Platform = process.platform,
	run: CommandRunner = runCommand,
): SecretStore | undefined {
	if (platform === "darwin") return new MacOsKeychain({ run });
	if (platform === "linux" || platform === "freebsd" || platform === "openbsd") return new LinuxSecretService({ run });
	if (platform === "win32") return new WindowsCredentialManager({ run });
	return undefined;
}

/** In-memory SecretStore for tests and for embedding. */
export class InMemorySecretStore implements SecretStore {
	readonly name = "in-memory keychain";
	readonly maxValueLength: number;
	readonly items = new Map<string, string>();
	private readonly isAvailable: boolean;

	constructor(options: { maxValueLength?: number; available?: boolean } = {}) {
		this.maxValueLength = options.maxValueLength ?? 1800;
		this.isAvailable = options.available ?? true;
	}

	available(): boolean {
		return this.isAvailable;
	}

	get(account: string): string | undefined {
		return this.items.get(account);
	}

	set(account: string, value: string): void {
		checkAccount(account);
		checkValue(this, value);
		this.items.set(account, value);
	}

	delete(account: string): void {
		this.items.delete(account);
	}
}
