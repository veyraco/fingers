// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * No duplicate reads ("from cache, read once"): when the model reads a file it already read in this conversation,
 * and neither the file nor the text the read would return has changed, the model gets a one-line note instead of the
 * file body again; the body is still in its earlier read result.
 *
 * A read is the same when its file (absolute path), offset and limit are the same; it is unchanged when the file's
 * mtime and size are the same and the read's text hashes the same (sha256 of exactly what the model got). Anything
 * else is a fresh read and replaces the entry. Only plain text reads count (images, errors and reads another tool
 * made are passed through). After a note, the next identical read sends the body again, so a model that lost track
 * of the earlier result can always get it back by reading once more. The cache is forgotten whenever the context is
 * rebuilt (compaction, session tree, another session), and a file's entries go when edit or write changes it.
 */
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { EeToolResult, EeToolResultChange } from "@veyraco/fingers";
import { estimateTokens, singleText } from "./text.ts";

interface ReadEntry {
	path: string;
	mtimeMs: number;
	size: number;
	hash: string;
	/** A note already stood in for this read: the next identical read sends the body. */
	served: boolean;
}

interface ReadCacheHit {
	change: EeToolResultChange;
	/** Tokens the body would have cost, minus the note's. */
	savedTokens: number;
}

/** "from cache, read once": the text the model gets instead of the body. */
export function readCacheNote(displayPath: string): string {
	return `[from cache, read once] ${displayPath} has not changed since your earlier read of it in this conversation, so its text is not sent again: use that earlier read result. Read it once more to get the text here.`;
}

function readKey(path: string, input: Record<string, unknown>): string {
	const offset = typeof input.offset === "number" ? input.offset : "";
	const limit = typeof input.limit === "number" ? input.limit : "";
	return JSON.stringify([path, offset, limit]);
}

export class ReadCache {
	private readonly entries = new Map<string, ReadEntry>();
	private readonly statFile: (path: string) => Promise<{ mtimeMs: number; size: number; isFile(): boolean }>;

	constructor(
		options: { stat?: (path: string) => Promise<{ mtimeMs: number; size: number; isFile(): boolean }> } = {},
	) {
		this.statFile = options.stat ?? ((path) => stat(path));
	}

	get size(): number {
		return this.entries.size;
	}

	/** A read result: the note when the same read of the unchanged file is already in the context, else undefined. */
	async onRead(result: EeToolResult): Promise<ReadCacheHit | undefined> {
		if (result.nested || result.isError || !result.path) return undefined;
		const text = singleText(result.content);
		if (text === undefined) return undefined;
		let file: { mtimeMs: number; size: number; isFile(): boolean };
		try {
			file = await this.statFile(result.path);
		} catch {
			return undefined;
		}
		if (!file.isFile()) return undefined;
		const key = readKey(result.path, result.input);
		const hash = createHash("sha256").update(text).digest("hex");
		const known = this.entries.get(key);
		const unchanged =
			known !== undefined && known.hash === hash && known.mtimeMs === file.mtimeMs && known.size === file.size;
		if (unchanged && !known.served) {
			const displayPath = typeof result.input.path === "string" ? result.input.path : result.path;
			const note = readCacheNote(displayPath);
			const savedTokens = estimateTokens(text) - estimateTokens(note);
			// A text shorter than the note goes as it is.
			if (savedTokens <= 0) return undefined;
			known.served = true;
			return { change: { content: [{ type: "text", text: note }] }, savedTokens };
		}
		this.entries.set(key, {
			path: result.path,
			mtimeMs: file.mtimeMs,
			size: file.size,
			hash,
			served: false,
		});
		return undefined;
	}

	/** Edit or write changed (or may have changed) this file: its reads are fresh again. */
	forgetFile(path: string): void {
		for (const [key, entry] of this.entries) if (entry.path === path) this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
	}
}
