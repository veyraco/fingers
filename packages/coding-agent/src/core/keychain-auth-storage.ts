/**
 * Credential storage in the OS keychain instead of a plaintext auth.json.
 *
 * The whole credential map (the JSON auth.json used to hold) is one blob in the keychain, split into
 * chunks that fit every platform's item size. A small marker file next to where auth.json lived holds
 * no secret: it names the keychain entry and changes on every write, so other Fingers processes notice
 * new credentials, and it is the file the cross-process lock is taken on.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuthOperationOptions } from "@veyraco/fingers-ai";
import { stripBom } from "../utils/text.ts";
import { AuthStorage, type AuthStorageBackend, FileAuthStorageBackend, ReadOnlyAuthStorage } from "./auth-storage.ts";
import { platformSecretStore, type SecretStore } from "./os-keychain.ts";

const BLOB_HEAD_VERSION = 1;

interface BlobHead {
	v: number;
	chunks: number;
	sha256: string;
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** A string of any length stored as base64 chunks under `<account>#<n>`, with a head item at `<account>`. */
export class KeychainBlob {
	private readonly store: SecretStore;
	readonly account: string;

	constructor(store: SecretStore, account: string) {
		this.store = store;
		this.account = account;
	}

	private chunkAccount(index: number): string {
		return `${this.account}#${index}`;
	}

	private readHead(): BlobHead | undefined {
		const raw = this.store.get(this.account);
		if (raw === undefined) return undefined;
		// `fingers-v1:<chunks>:<sha256>`: no quotes or spaces, so every keychain tool takes it as is.
		const match = raw.match(/^fingers-v(\d+):(\d+):([0-9a-f]{64})$/);
		if (!match) throw new Error(`${this.store.name}: the Fingers credentials entry is damaged`);
		const head: BlobHead = { v: Number(match[1]), chunks: Number(match[2]), sha256: match[3] };
		if (head.v !== BLOB_HEAD_VERSION) {
			throw new Error(`${this.store.name}: the Fingers credentials entry has an unknown format`);
		}
		return head;
	}

	read(): string | undefined {
		const head = this.readHead();
		if (!head) return undefined;
		let encoded = "";
		for (let index = 1; index <= head.chunks; index++) {
			const chunk = this.store.get(this.chunkAccount(index));
			if (chunk === undefined)
				throw new Error(`${this.store.name}: part ${index} of the Fingers credentials is missing`);
			encoded += chunk;
		}
		const text = Buffer.from(encoded, "base64").toString("utf-8");
		if (sha256(text) !== head.sha256) {
			throw new Error(`${this.store.name}: the Fingers credentials do not match their checksum`);
		}
		return text;
	}

	write(text: string): void {
		const previous = this.safeHead();
		const encoded = Buffer.from(text, "utf-8").toString("base64");
		const size = this.store.maxValueLength;
		const chunks = Math.ceil(encoded.length / size);
		// Chunks first, head last: a reader sees either the old head (and checksum fails while chunks
		// are half written, so it keeps its last good copy) or the complete new blob.
		for (let index = 1; index <= chunks; index++) {
			this.store.set(this.chunkAccount(index), encoded.slice((index - 1) * size, index * size));
		}
		this.store.set(this.account, `fingers-v${BLOB_HEAD_VERSION}:${chunks}:${sha256(text)}`);
		for (let index = chunks + 1; index <= (previous?.chunks ?? 0); index++) {
			this.store.delete(this.chunkAccount(index));
		}
	}

	delete(): void {
		const head = this.safeHead();
		for (let index = 1; index <= (head?.chunks ?? 0); index++) this.store.delete(this.chunkAccount(index));
		this.store.delete(this.account);
	}

	private safeHead(): BlobHead | undefined {
		try {
			return this.readHead();
		} catch {
			return undefined;
		}
	}
}

/** Keychain account for an auth path. Hashed so paths with spaces or user names never reach the keychain. */
export function keychainAccountFor(authPath: string): string {
	return `auth:${sha256(authPath).slice(0, 16)}`;
}

/** Marker file that replaces auth.json when credentials live in the keychain. */
export function keychainMarkerPath(authPath: string): string {
	return join(dirname(authPath), "auth.keychain.json");
}

interface MarkerContent {
	store: "os-keychain";
	keychain: string;
	service: string;
	account: string;
	note: string;
	revision: string;
}

/**
 * AuthStorageBackend over a KeychainBlob. Locking reuses the file backend's lock on the marker file,
 * whose content is rewritten (new revision) after every keychain write.
 */
export class KeychainAuthStorageBackend implements AuthStorageBackend {
	private readonly blob: KeychainBlob;
	private readonly lockBackend: FileAuthStorageBackend;
	private readonly store: SecretStore;
	private readonly service: string;
	readonly markerPath: string;

	constructor(store: SecretStore, markerPath: string, account: string, service: string) {
		this.store = store;
		this.markerPath = markerPath;
		this.service = service;
		this.blob = new KeychainBlob(store, account);
		this.lockBackend = new FileAuthStorageBackend(markerPath);
	}

	private marker(): string {
		const content: MarkerContent = {
			store: "os-keychain",
			keychain: this.store.name,
			service: this.service,
			account: this.blob.account,
			note: "Fingers keeps your provider credentials in the OS keychain. This file holds no secret.",
			revision: randomBytes(8).toString("hex"),
		};
		return `${JSON.stringify(content, null, 2)}\n`;
	}

	withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
		return this.lockBackend.withLock(() => {
			const { result, next } = fn(this.blob.read());
			if (next === undefined) return { result };
			this.blob.write(next);
			return { result, next: this.marker() };
		});
	}

	withLockAsync<T>(
		fn: (current: string | undefined) => Promise<{ result: T; next?: string }>,
		options?: AuthOperationOptions,
	): Promise<T> {
		return this.lockBackend.withLockAsync(async () => {
			const { result, next } = await fn(this.blob.read());
			if (next === undefined) return { result };
			options?.signal?.throwIfAborted();
			this.blob.write(next);
			return { result, next: this.marker() };
		}, options);
	}
}

export type CredentialStoreKind = "os-keychain" | "file";

export interface CredentialStorageInfo {
	kind: CredentialStoreKind;
	/** Where credentials live, for messages: "macOS Keychain" or the auth.json path. */
	location: string;
	/** Providers moved from a plaintext auth.json into the keychain on this start. */
	migratedProviders: string[];
	/** Why the keychain is not used, when kind is "file". */
	fallbackReason?: string;
}

export interface OpenCredentialStorageOptions {
	authPath: string;
	env?: NodeJS.ProcessEnv;
	/** Defaults to the platform keychain. */
	secretStore?: SecretStore;
	service?: string;
}

export interface OpenedCredentialStorage {
	storage: AuthStorage;
	info: CredentialStorageInfo;
}

/**
 * Read-only view for `fingers auth check --no-refresh`: never writes, never migrates. Reads the keychain
 * entry, or a not yet migrated auth.json when the keychain holds none.
 */
export function openReadOnlyCredentialStorage(options: OpenCredentialStorageOptions): ReadOnlyAuthStorage {
	const env = options.env ?? process.env;
	const authPath = options.authPath;
	const requested = (env.FINGERS_CREDENTIAL_STORE ?? "keychain").trim().toLowerCase();
	if (requested !== "keychain") return new ReadOnlyAuthStorage(authPath);
	const store = options.secretStore ?? platformSecretStore();
	if (!store || !store.available()) return new ReadOnlyAuthStorage(authPath);
	const blob = new KeychainBlob(store, keychainAccountFor(authPath));
	return new ReadOnlyAuthStorage(
		() => blob.read() ?? (existsSync(authPath) ? readFileSync(authPath, "utf-8") : undefined),
	);
}

/** Parse a plaintext auth.json; undefined when absent or empty. */
function readPlaintextAuthFile(authPath: string): Record<string, unknown> | undefined {
	if (!existsSync(authPath)) return undefined;
	const text = stripBom(readFileSync(authPath, "utf-8")).trim();
	if (!text) return {};
	const parsed = JSON.parse(text) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Invalid auth.json: expected an object");
	}
	return parsed as Record<string, unknown>;
}

/**
 * Move a plaintext auth.json into the keychain blob. Entries already in the keychain win over the file
 * (the keychain is the newer store). The file is deleted only after the merged blob reads back intact.
 */
function migratePlaintextFile(backend: KeychainAuthStorageBackend, authPath: string): string[] {
	if (!existsSync(authPath)) return [];
	let migrated: string[] = [];
	backend.withLock((current) => {
		const fileData = readPlaintextAuthFile(authPath);
		if (fileData === undefined) return { result: undefined };
		const keychainData = current ? (JSON.parse(current) as Record<string, unknown>) : {};
		migrated = Object.keys(fileData).filter((provider) => !(provider in keychainData));
		const merged = { ...fileData, ...keychainData };
		return { result: undefined, next: JSON.stringify(merged, null, 2) };
	});
	// Verify before removing the only other copy.
	const check = backend.withLock((current) => ({ result: current }));
	const stored = check ? (JSON.parse(check) as Record<string, unknown>) : {};
	const fileData = readPlaintextAuthFile(authPath);
	if (fileData && Object.keys(fileData).some((provider) => !(provider in stored))) {
		throw new Error("credentials did not read back from the keychain; auth.json was kept");
	}
	if (fileData) removePlaintextFile(authPath);
	return migrated;
}

/** Overwrite, rename and unlink, so the old key bytes do not stay in the original file's blocks. */
function removePlaintextFile(authPath: string): void {
	try {
		const size = readFileSync(authPath).length;
		writeFileSync(authPath, Buffer.alloc(size, 0));
		const tombstone = `${authPath}.${randomBytes(4).toString("hex")}.deleted`;
		renameSync(authPath, tombstone);
		unlinkSync(tombstone);
	} catch {
		if (existsSync(authPath)) unlinkSync(authPath);
	}
}

/**
 * Open the credential storage for an auth path.
 *
 * FINGERS_CREDENTIAL_STORE selects it: "keychain" (default) uses the OS keychain and moves an existing
 * auth.json into it; "file" keeps the plaintext auth.json. When no keychain is reachable (headless Linux
 * without a Secret Service, containers), the file is used and info.fallbackReason says why.
 */
export function openCredentialStorage(options: OpenCredentialStorageOptions): OpenedCredentialStorage {
	const env = options.env ?? process.env;
	const authPath = options.authPath;
	const requested = (env.FINGERS_CREDENTIAL_STORE ?? "keychain").trim().toLowerCase();
	const fileStorage = (fallbackReason?: string): OpenedCredentialStorage => ({
		storage: AuthStorage.create(authPath),
		info: { kind: "file", location: authPath, migratedProviders: [], fallbackReason },
	});
	if (requested === "file") return fileStorage();
	if (requested !== "keychain") {
		throw new Error(`FINGERS_CREDENTIAL_STORE must be "keychain" or "file", not "${requested}"`);
	}

	const store = options.secretStore ?? platformSecretStore();
	if (!store) return fileStorage(`no OS keychain on ${process.platform}`);
	if (!store.available()) return fileStorage(`${store.name} is not reachable`);

	const markerPath = keychainMarkerPath(authPath);
	const dir = dirname(markerPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const service = options.service ?? "Veyra Fingers";
	const backend = new KeychainAuthStorageBackend(store, markerPath, keychainAccountFor(authPath), service);
	let migratedProviders: string[] = [];
	try {
		migratedProviders = migratePlaintextFile(backend, authPath);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return fileStorage(`${store.name}: ${reason}`);
	}
	return {
		storage: AuthStorage.fromStorage(backend, markerPath),
		info: { kind: "os-keychain", location: store.name, migratedProviders },
	};
}
