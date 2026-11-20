/**
 * `file_changed` events: the edit and write tools' effect on a workspace file, from a snapshot taken right
 * before the call runs and the file after it. Shell commands are not tracked here.
 */
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { diffLines } from "diff";
import { resolveToCwd } from "../../../core/tools/path-utils.ts";
import { WRITE_TOOLS } from "./path-policy.ts";

export interface FileChange {
	path: string;
	change: "added" | "modified" | "deleted";
	additions: number;
	deletions: number;
}

const MAX_TRACKED_BYTES = 4 * 1024 * 1024;

function readText(path: string): string | undefined {
	try {
		const buffer = readFileSync(path);
		return buffer.length > MAX_TRACKED_BYTES
			? buffer.subarray(0, MAX_TRACKED_BYTES).toString("utf8")
			: buffer.toString("utf8");
	} catch {
		return undefined;
	}
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export class FileChangeTracker {
	private readonly workspaceRoot: string;
	private readonly snapshots = new Map<string, { absolute: string; before: string | undefined }>();

	constructor(workspaceRoot: string) {
		this.workspaceRoot = workspaceRoot;
	}

	/** Snapshot the target of an edit or write call (synchronous, so event order is kept). */
	before(toolCallId: string, toolName: string, input: Record<string, unknown>): void {
		if (!WRITE_TOOLS.has(toolName) || typeof input.path !== "string") return;
		const absolute = resolveToCwd(input.path, this.workspaceRoot);
		this.snapshots.set(toolCallId, { absolute, before: readText(absolute) });
	}

	/** The change the call made, or undefined when it changed nothing (or was not a tracked tool). */
	after(toolCallId: string): FileChange | undefined {
		const snapshot = this.snapshots.get(toolCallId);
		if (!snapshot) return undefined;
		this.snapshots.delete(toolCallId);
		const after = readText(snapshot.absolute);
		if (after === snapshot.before) return undefined;
		const path = relative(this.workspaceRoot, snapshot.absolute).split(sep).join("/");
		if (snapshot.before === undefined) {
			return { path, change: "added", additions: countLines(after ?? ""), deletions: 0 };
		}
		if (after === undefined) {
			return { path, change: "deleted", additions: 0, deletions: countLines(snapshot.before) };
		}
		let additions = 0;
		let deletions = 0;
		for (const part of diffLines(snapshot.before, after)) {
			if (part.added) additions += part.count ?? countLines(part.value);
			else if (part.removed) deletions += part.count ?? countLines(part.value);
		}
		return { path, change: "modified", additions, deletions };
	}

	/** Forget a snapshot whose call did not run. */
	discard(toolCallId: string): void {
		this.snapshots.delete(toolCallId);
	}
}
