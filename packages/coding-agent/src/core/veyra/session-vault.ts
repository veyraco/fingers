/**
 * Where `fingers login` keeps the Veyra sign-in: the OS keychain only. The refresh token, the access tokens per
 * audience and who signed in are one JSON blob in the keychain (KeychainBlob, service "Veyra Fingers", one account
 * per Connect issuer). Nothing with a token is ever written to a file.
 *
 * A small marker file in the agent directory holds no secret: it says whether a sign-in exists (so a start without one
 * never touches the keychain) and it is the file the cross-process lock is taken on. Connect rotates the refresh token
 * on every refresh and ends the session when a spent one comes back, so two fingers processes must never refresh with
 * the same token: every change happens under the lock, after reading the keychain again.
 *
 * Without a usable keychain (FINGERS_CREDENTIAL_STORE=file, none on this platform, or not reachable) the sign-in is
 * kept in memory for this process only, and `storage.memoryReason` says why.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileAuthStorageBackend } from "../auth-storage.ts";
import { KeychainBlob } from "../keychain-auth-storage.ts";
import { KEYCHAIN_SERVICE, platformSecretStore, type SecretStore } from "../os-keychain.ts";

export interface StoredAccessToken {
	token: string;
	/** Epoch ms. */
	expires_at: number;
}

/** The sign-in as the keychain holds it. */
export interface StoredVeyraSession {
	v: 1;
	issuer: string;
	client_id: string;
	refresh_token?: string;
	scope?: string;
	subject: string;
	email?: string;
	name?: string;
	org?: string;
	member?: string;
	group?: string;
	group_key?: string;
	/** Connect's app session id (`sid`): the device under Connected apps. */
	sid?: string;
	/** The organization as Connect's API last described it (shown without a request). */
	org_name?: string;
	org_code?: string;
	tier?: string;
	group_name?: string;
	/** Epoch ms. */
	signed_in_at: number;
	access: Record<string, StoredAccessToken>;
}

export interface VeyraStorageInfo {
	/** Kept in the OS keychain across runs; false: in this process' memory only. */
	persistent: boolean;
	/** "macOS Keychain", "Secret Service", "Windows Credential Manager", or "memory". */
	location: string;
	memoryReason?: string;
}

/** Who signed in, without any token: what whoami, /org and the status line show. */
export interface VeyraAccount {
	issuer: string;
	subject: string;
	email?: string;
	name?: string;
	org?: string;
	member?: string;
	group?: string;
	groupKey?: string;
	/** From the last organization lookup at Connect. */
	orgName?: string;
	orgCode?: string;
	tier?: string;
	groupName?: string;
	sessionId?: string;
	signedInAt: number;
	storage: VeyraStorageInfo;
}

export function veyraSessionAccount(session: StoredVeyraSession, storage: VeyraStorageInfo): VeyraAccount {
	return {
		issuer: session.issuer,
		subject: session.subject,
		email: session.email,
		name: session.name,
		org: session.org,
		member: session.member,
		group: session.group,
		groupKey: session.group_key,
		orgName: session.org_name,
		orgCode: session.org_code,
		tier: session.tier,
		groupName: session.group_name,
		sessionId: session.sid,
		signedInAt: session.signed_in_at,
		storage,
	};
}

/** `next`: the session to store, `null` to delete it, undefined to leave it as it is. */
export type VaultUpdate<T> = (
	current: StoredVeyraSession | undefined,
) => Promise<{ result: T; next?: StoredVeyraSession | null }>;

export interface VeyraSessionVault {
	readonly storage: VeyraStorageInfo;
	/** The stored sign-in, without taking the lock. */
	read(): StoredVeyraSession | undefined;
	/**
	 * Read, change and write under the cross-process lock. `signal` ends only the wait for the lock: once `fn` runs,
	 * the change finishes and is written, so a refresh Connect already answered is never dropped (Connect ends the
	 * session when the spent refresh token comes back).
	 */
	update<T>(fn: VaultUpdate<T>, signal?: AbortSignal): Promise<T>;
	/**
	 * Delete the sign-in without the lock: sign out when another fingers process holds the lock past the wait.
	 * Signing out is idempotent, so this is safe to repeat.
	 */
	clearWithoutLock(): void;
}

function parseSession(text: string | undefined, issuer: string): StoredVeyraSession | undefined {
	if (!text) return undefined;
	try {
		const value = JSON.parse(text) as StoredVeyraSession;
		if (value?.v !== 1 || value.issuer !== issuer || typeof value.subject !== "string") return undefined;
		return { ...value, access: value.access ?? {} };
	} catch {
		return undefined;
	}
}

function issuerHash(issuer: string): string {
	return createHash("sha256").update(issuer, "utf-8").digest("hex").slice(0, 16);
}

class KeychainSessionVault implements VeyraSessionVault {
	readonly storage: VeyraStorageInfo;
	private readonly store: SecretStore;
	private readonly markerPath: string;
	private readonly issuer: string;
	private readonly service: string;
	private readonly blob: KeychainBlob;
	private readonly lock: FileAuthStorageBackend;

	constructor(store: SecretStore, markerPath: string, issuer: string, service: string, lockWaitMs?: number) {
		this.store = store;
		this.markerPath = markerPath;
		this.issuer = issuer;
		this.service = service;
		this.storage = { persistent: true, location: store.name };
		// One keychain account per Connect issuer.
		this.blob = new KeychainBlob(store, `veyra:${issuerHash(issuer)}`);
		this.lock = new FileAuthStorageBackend(markerPath, { lockWaitMs });
	}

	signedInByMarker(): boolean {
		if (!existsSync(this.markerPath)) return false;
		try {
			return (JSON.parse(readFileSync(this.markerPath, "utf-8")) as { signed_in?: unknown }).signed_in === true;
		} catch {
			return false;
		}
	}

	read(): StoredVeyraSession | undefined {
		if (!this.signedInByMarker()) return undefined;
		try {
			return parseSession(this.blob.read(), this.issuer);
		} catch {
			return undefined;
		}
	}

	private readUnderLock(): StoredVeyraSession | undefined {
		try {
			return parseSession(this.blob.read(), this.issuer);
		} catch {
			return undefined;
		}
	}

	private marker(signedIn: boolean): string {
		const content = {
			store: "os-keychain",
			keychain: this.store.name,
			service: this.service,
			account: this.blob.account,
			issuer: this.issuer,
			signed_in: signedIn,
			note: "Fingers keeps your Veyra sign-in in the OS keychain. This file holds no secret.",
			revision: randomBytes(8).toString("hex"),
		};
		return `${JSON.stringify(content, null, 2)}\n`;
	}

	update<T>(fn: VaultUpdate<T>, signal?: AbortSignal): Promise<T> {
		// The lock helper also checks its signal after the change; this one follows the caller's only until `fn` starts.
		const lockWait = new AbortController();
		const forward = () => lockWait.abort(signal?.reason);
		if (signal?.aborted) forward();
		else signal?.addEventListener("abort", forward, { once: true });
		return this.lock
			.withLockAsync(
				async () => {
					signal?.removeEventListener("abort", forward);
					const { result, next } = await fn(this.readUnderLock());
					if (next === undefined) return { result };
					if (next === null) {
						this.blob.delete();
						return { result, next: this.marker(false) };
					}
					this.blob.write(JSON.stringify(next));
					return { result, next: this.marker(true) };
				},
				signal ? { signal: lockWait.signal } : undefined,
			)
			.finally(() => signal?.removeEventListener("abort", forward));
	}

	clearWithoutLock(): void {
		this.blob.delete();
		try {
			writeFileSync(this.markerPath, this.marker(false), { encoding: "utf-8", mode: 0o600 });
		} catch {
			// The keychain is the record: without the blob, read() finds no sign-in whatever the marker says.
		}
	}
}

class MemorySessionVault implements VeyraSessionVault {
	readonly storage: VeyraStorageInfo;
	private session: StoredVeyraSession | undefined;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(reason: string) {
		this.storage = { persistent: false, location: "memory", memoryReason: reason };
	}

	read(): StoredVeyraSession | undefined {
		return this.session;
	}

	update<T>(fn: VaultUpdate<T>): Promise<T> {
		const run = this.queue.then(async () => {
			const { result, next } = await fn(this.session);
			if (next === null) this.session = undefined;
			else if (next !== undefined) this.session = next;
			return result;
		});
		this.queue = run.catch(() => {});
		return run;
	}

	clearWithoutLock(): void {
		this.session = undefined;
	}
}

export interface OpenVeyraSessionVaultOptions {
	agentDir: string;
	issuer: string;
	env?: NodeJS.ProcessEnv;
	/** Defaults to the platform keychain. */
	secretStore?: SecretStore;
	service?: string;
	/** How long a change waits for another fingers process' lock before it gives up (default 30 s). */
	lockWaitMs?: number;
}

/**
 * The vault for the sign-in to `issuer`. The keychain is probed only when needed: a start without a sign-in (no
 * marker) reads nothing.
 */
export function openVeyraSessionVault(options: OpenVeyraSessionVaultOptions): VeyraSessionVault {
	const env = options.env ?? process.env;
	const requested = (env.FINGERS_CREDENTIAL_STORE ?? "keychain").trim().toLowerCase();
	if (requested === "file") {
		// Provider keys may go to auth.json then; Veyra tokens never go to a file.
		return new MemorySessionVault("FINGERS_CREDENTIAL_STORE=file is set");
	}
	if (requested !== "keychain") {
		return new MemorySessionVault(`FINGERS_CREDENTIAL_STORE is "${requested}", not "keychain"`);
	}
	// The secret-free marker (and lock file) of the sign-in to this Connect.
	const markerPath = join(options.agentDir, `veyra-session.${issuerHash(options.issuer)}.json`);
	const service = options.service ?? KEYCHAIN_SERVICE;
	let resolved: KeychainSessionVault | MemorySessionVault | undefined;
	const resolve = (): KeychainSessionVault | MemorySessionVault => {
		if (resolved) return resolved;
		const store = options.secretStore ?? platformSecretStore();
		if (!store) resolved = new MemorySessionVault(`there is no OS keychain Fingers can use on ${process.platform}`);
		else if (!store.available()) resolved = new MemorySessionVault(`the ${store.name} is not reachable`);
		else resolved = new KeychainSessionVault(store, markerPath, options.issuer, service, options.lockWaitMs);
		return resolved;
	};
	return {
		get storage() {
			return resolve().storage;
		},
		read() {
			if (!resolved && !existsSync(markerPath)) return undefined;
			return resolve().read();
		},
		update(fn, signal) {
			return resolve().update(fn, signal);
		},
		clearWithoutLock() {
			resolve().clearWithoutLock();
		},
	};
}
