/**
 * Checkpoints for managed mode (Fingers RPC v1 `checkpoint_export` / `checkpoint_import`).
 *
 * A checkpoint (`fingers.session.v1`) is a Fingers session file: the session header and every entry, one
 * JSON object per line, with every host secret removed. The host stores the file (Hands uploads it) and hands
 * it back later, possibly to a fresh process in another sandbox; `sha256` proves it is the same file.
 *
 * Files are only written to and read from `configure.checkpoints.dir`: the path is checked logically and
 * after resolving symlinks, like the managed tool path policy.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { FileEntry, SessionHeader, SessionManager } from "../../../core/session-manager.ts";
import { inside, physicalPath } from "./path-policy.ts";

export const CHECKPOINT_FORMAT = "fingers.session.v1";

/** A checkpoint bigger than this is refused on import (a session file of this size is not a real session). */
const MAX_CHECKPOINT_BYTES = 512 * 1024 * 1024;

export class CheckpointError extends Error {
	readonly code: "path_not_allowed" | "not_found" | "checksum_mismatch" | "invalid_command";

	constructor(code: CheckpointError["code"], message: string) {
		super(message);
		this.name = "CheckpointError";
		this.code = code;
	}
}

/**
 * The path a checkpoint may be written to or read from, resolved through symlinks. Throws `path_not_allowed`
 * unless it lies inside `dir`, both as written and after resolving every existing ancestor.
 */
export async function resolveCheckpointPath(path: string, dir: string | undefined): Promise<string> {
	if (!dir) throw new CheckpointError("path_not_allowed", "No checkpoints.dir was configured");
	const logicalDir = resolve(dir);
	const logical = resolve(path);
	if (logical === logicalDir || !inside(logicalDir, logical)) {
		throw new CheckpointError("path_not_allowed", "The checkpoint path is outside checkpoints.dir");
	}
	let physicalDir: string;
	try {
		physicalDir = await realpath(logicalDir);
	} catch {
		throw new CheckpointError("path_not_allowed", `checkpoints.dir does not exist: ${logicalDir}`);
	}
	let physical: string;
	try {
		physical = await physicalPath(logical);
	} catch {
		throw new CheckpointError("path_not_allowed", "The checkpoint path cannot be resolved");
	}
	if (physical === physicalDir || !inside(physicalDir, physical)) {
		throw new CheckpointError("path_not_allowed", "The checkpoint path leaves checkpoints.dir");
	}
	return physical;
}

/** The checkpoint id: the file name when it already is one (`cp_6.jsonl` -> `cp_6`), else derived from the hash. */
export function checkpointId(path: string, sha256: string): string {
	const name = basename(path).replace(/\.[^.]*$/, "");
	return /^cp_[A-Za-z0-9]{1,64}$/.test(name) ? name : `cp_${sha256.slice(0, 24)}`;
}

/** The session as checkpoint file content, each line passed through `redact`. */
export function serializeCheckpoint(sessionManager: SessionManager, redact: (line: string) => string): string {
	const header = sessionManager.getHeader();
	if (!header) throw new Error("The session has no header");
	const entries: FileEntry[] = [header, ...sessionManager.getEntries()];
	return entries.map((entry) => `${redact(JSON.stringify(entry))}\n`).join("");
}

/** Count of the conversation messages on the branch that ends at the session's leaf. */
export function branchMessageCount(sessionManager: SessionManager): number {
	return sessionManager.getBranch().filter((entry) => entry.type === "message").length;
}

/**
 * Write `content` to `path` atomically (a temporary file in the same directory, then a rename), readable by
 * the owner only. Returns its size and SHA-256.
 */
export async function writeCheckpointFile(
	path: string,
	content: string,
): Promise<{ sha256: string; sizeBytes: number }> {
	const bytes = Buffer.from(content, "utf8");
	await mkdir(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
	try {
		const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
	return { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
}

interface LoadedCheckpoint {
	header: SessionHeader;
	entries: FileEntry[];
}

/**
 * Read a checkpoint, check its SHA-256, and parse it strictly: every line is a JSON object with a `type`, and
 * the first is the session header.
 */
export async function readCheckpointFile(path: string, expectedSha256: string): Promise<LoadedCheckpoint> {
	let size: number;
	try {
		const info = await stat(path);
		if (!info.isFile()) throw new CheckpointError("invalid_command", "The checkpoint path is not a file");
		size = info.size;
	} catch (error) {
		if (error instanceof CheckpointError) throw error;
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new CheckpointError("not_found", "No checkpoint file at that path");
		}
		throw error;
	}
	if (size > MAX_CHECKPOINT_BYTES) {
		throw new CheckpointError("invalid_command", `The checkpoint is larger than ${MAX_CHECKPOINT_BYTES} bytes`);
	}
	const bytes = await readFile(path);
	const actual = createHash("sha256").update(bytes).digest("hex");
	if (actual !== expectedSha256.toLowerCase()) {
		throw new CheckpointError("checksum_mismatch", "The checkpoint's SHA-256 does not match");
	}
	const entries: FileEntry[] = [];
	for (const line of bytes.toString("utf8").split("\n")) {
		if (!line.trim()) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			throw new CheckpointError("invalid_command", `The file is not a ${CHECKPOINT_FORMAT} checkpoint`);
		}
		if (typeof entry !== "object" || entry === null || typeof (entry as { type?: unknown }).type !== "string") {
			throw new CheckpointError("invalid_command", `The file is not a ${CHECKPOINT_FORMAT} checkpoint`);
		}
		entries.push(entry as FileEntry);
	}
	const header = entries[0];
	if (!header || header.type !== "session" || typeof header.id !== "string" || header.id.length === 0) {
		throw new CheckpointError(
			"invalid_command",
			`The file is not a ${CHECKPOINT_FORMAT} checkpoint (no session header)`,
		);
	}
	for (const entry of entries.slice(1)) {
		if (entry.type === "session" || typeof (entry as { id?: unknown }).id !== "string") {
			throw new CheckpointError("invalid_command", `The file is not a ${CHECKPOINT_FORMAT} checkpoint (bad entry)`);
		}
	}
	return { header, entries };
}

/**
 * Store a checkpoint as a session file in `sessionDir`, owned by this workspace: the header's `cwd` becomes
 * `workspaceRoot`, so the session's tools and later forks work in this process' workspace. Returns the path.
 */
export async function storeImportedSession(
	checkpoint: LoadedCheckpoint,
	sessionDir: string,
	workspaceRoot: string,
): Promise<string> {
	await mkdir(sessionDir, { recursive: true });
	const header: SessionHeader = { ...checkpoint.header, cwd: workspaceRoot };
	const content = [header, ...checkpoint.entries.slice(1)].map((entry) => `${JSON.stringify(entry)}\n`).join("");
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	for (let attempt = 0; ; attempt++) {
		const suffix = attempt === 0 ? "" : `-${attempt}`;
		const path = join(sessionDir, `${stamp}_${header.id}${suffix}.jsonl`);
		try {
			const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
			try {
				await handle.writeFile(content);
			} finally {
				await handle.close();
			}
			return path;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 100) throw error;
		}
	}
}
