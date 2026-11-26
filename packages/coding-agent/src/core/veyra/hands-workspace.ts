/**
 * The person's workspace for a Hands-backed session (F13b): what goes up into the sandbox, and how the run's changes
 * come back into the working tree.
 *
 * Up (hands.yaml `Workspace`, `POST /files`):
 * - **git**: a repository whose HEAD commit is on a remote-tracking branch of `origin` is cloned by Hands at that
 *   commit (`owner/name` for github.com, through Connect's connector broker; another https remote as its URL). The
 *   local changes (modified and untracked files, ignored files left out) go as the overlay `file_ids`. A local
 *   deletion can't be an overlay, so it is refused with a clear message.
 * - **files**: anything else (no remote Hands can clone, HEAD not pushed, no git): the non-ignored files, uploaded one
 *   by one at their paths.
 * - Hands takes at most 100 files per workspace (`file_ids` maxItems) and 500 MiB per file; beyond that the session is
 *   refused with what to do instead. Symbolic links are left out.
 *
 * Back (hands.yaml listRunFiles, getRunFileContent): each changed file is written into the root, a deleted one is
 * removed. Paths are checked (relative, no `..`, no `.git`, never through a symbolic link). A file the person changed
 * while the run worked (size or mtime differ from the start, or it appeared) is kept as it is, and the run's version is
 * saved under `.fingers/hands/<run id>/<path>` instead.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { execCommand } from "../exec.ts";
import { repositoryIdFromRemote } from "../memory/project.ts";
import type { HandsChangedFile, HandsClient, HandsWorkspace } from "./hands-client.ts";

/** Hands' limits (hands.yaml Workspace.file_ids maxItems, uploadFile "Up to 500 MB"). */
export const MAX_WORKSPACE_FILES = 100;
export const MAX_FILE_BYTES = 500 * 1024 * 1024;

/** Where conflicting files from a run are kept, under the root. */
export const HANDS_CONFLICT_DIR = join(".fingers", "hands");

export class HandsWorkspaceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HandsWorkspaceError";
	}
}

export interface WorkspaceFileStat {
	size: number;
	mtimeMs: number;
}

export interface WorkspacePlan {
	/** The directory the sandbox's /workspace mirrors: the git top level, or the working directory. */
	root: string;
	kind: "git" | "files" | "empty";
	/** For git: what Hands clones. */
	repo?: string;
	ref?: string;
	/** Files that go up (git: the overlay; files: all of them), relative with `/`. */
	upload: string[];
	/** Size and mtime of every file in the root at the start, for the pull-back's conflict check. */
	start: Map<string, WorkspaceFileStat>;
	/** One line for the session header: `git acme/web @ 1a2b3c4 + 2 changed files`. */
	summary: string;
}

export type Git = (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;

export const runGit: Git = async (args, cwd) => {
	try {
		const result = await execCommand("git", ["-c", "core.quotepath=off", ...args], cwd, {
			timeout: 15_000,
			maxBuffer: 64 * 1024 * 1024,
		});
		return { code: result.code, stdout: result.stdout };
	} catch {
		return { code: 127, stdout: "" };
	}
};

function toPosix(path: string): string {
	return sep === "/" ? path : path.split(sep).join("/");
}

function splitZ(text: string): string[] {
	return text.split("\0").filter((entry) => entry.length > 0);
}

/** `owner/name` for a github.com remote, the https URL for another https remote, undefined otherwise. */
export function cloneSource(remote: string): string | undefined {
	const id = repositoryIdFromRemote(remote);
	if (!id) return undefined;
	const [host, ...rest] = id.split("/");
	if (host === "github.com" && rest.length === 2) return rest.join("/");
	const value = remote.trim();
	if (/^https:\/\//i.test(value)) {
		try {
			const url = new URL(value);
			if (url.username || url.password) return `https://${url.host}${url.pathname}`;
			return url.toString();
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function statOf(root: string, path: string): WorkspaceFileStat | undefined {
	try {
		const stat = lstatSync(join(root, path));
		return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : undefined;
	} catch {
		return undefined;
	}
}

/** Regular files under `root`, without `.git`, `node_modules` and `.fingers`; symbolic links left out. */
function walk(root: string, limit: number): string[] {
	const found: string[] = [];
	const visit = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (found.length > limit) return;
			if (entry.isDirectory()) {
				if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".fingers") continue;
				visit(join(dir, entry.name));
			} else if (entry.isFile()) {
				found.push(toPosix(relative(root, join(dir, entry.name))));
			}
		}
	};
	visit(root);
	return found;
}

function tooMany(count: number): HandsWorkspaceError {
	return new HandsWorkspaceError(
		`Hands takes at most ${MAX_WORKSPACE_FILES} files without a pushed commit, and this workspace has ${count > MAX_WORKSPACE_FILES * 10 ? "many more" : count}. Push HEAD to origin so Hands clones the repository (your local changes then go along), or run locally without --hands.`,
	);
}

/** What goes into the sandbox for `cwd`, without uploading anything yet. */
export async function planWorkspace(cwd: string, git: Git = runGit): Promise<WorkspacePlan> {
	const top = await git(["rev-parse", "--show-toplevel"], cwd);
	if (top.code !== 0 || !top.stdout.trim()) {
		const files = walk(cwd, MAX_WORKSPACE_FILES * 10);
		return finishFilesPlan(cwd, files, "files");
	}
	const root = top.stdout.trim();
	const listed = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root);
	const tracked = splitZ(listed.stdout).filter((path) => statOf(root, path) !== undefined);

	const remote = (await git(["config", "--get", "remote.origin.url"], root)).stdout.trim();
	const source = remote ? cloneSource(remote) : undefined;
	const head = (await git(["rev-parse", "--verify", "HEAD"], root)).stdout.trim();
	const pushed =
		source && /^[0-9a-f]{40,64}$/.test(head)
			? (await git(["branch", "-r", "--contains", head], root)).stdout
					.split("\n")
					.some((line) => line.trim().startsWith("origin/"))
			: false;
	if (!source || !pushed) return finishFilesPlan(root, tracked, source ? "unpushed" : "files");

	const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], root);
	const overlay: string[] = [];
	const deleted: string[] = [];
	for (const entry of splitZ(status.stdout)) {
		const code = entry.slice(0, 2);
		const path = entry.slice(3);
		if (code.includes("D")) deleted.push(path);
		else if (statOf(root, path)) overlay.push(path);
	}
	if (deleted.length > 0) {
		throw new HandsWorkspaceError(
			`Hands starts from the pushed commit plus your changed files, and can't take a deleted file (${deleted.slice(0, 3).join(", ")}${deleted.length > 3 ? ", …" : ""}). Commit or stash the deletion first.`,
		);
	}
	if (overlay.length > MAX_WORKSPACE_FILES) {
		throw new HandsWorkspaceError(
			`Hands takes at most ${MAX_WORKSPACE_FILES} changed files on top of the pushed commit, and you have ${overlay.length}. Commit and push them first.`,
		);
	}
	const start = new Map<string, WorkspaceFileStat>();
	for (const path of new Set([...tracked, ...overlay])) {
		const stat = statOf(root, path);
		if (stat) start.set(path, stat);
	}
	checkSizes(root, overlay);
	const short = head.slice(0, 7);
	return {
		root,
		kind: "git",
		repo: source,
		ref: head,
		upload: overlay,
		start,
		summary: `git ${source} @ ${short}${overlay.length > 0 ? ` + ${overlay.length} changed file${overlay.length === 1 ? "" : "s"}` : ""}`,
	};
}

function checkSizes(root: string, paths: readonly string[]): void {
	for (const path of paths) {
		const stat = statOf(root, path);
		if (stat && stat.size > MAX_FILE_BYTES) {
			throw new HandsWorkspaceError(`${path} is larger than Hands takes (500 MiB per file).`);
		}
	}
}

function finishFilesPlan(root: string, files: string[], why: "files" | "unpushed"): WorkspacePlan {
	if (files.length > MAX_WORKSPACE_FILES) {
		if (why === "unpushed") {
			throw new HandsWorkspaceError(
				`HEAD is not on a branch of origin, and Hands takes at most ${MAX_WORKSPACE_FILES} files without a pushed commit (this workspace has ${files.length}). Push HEAD to origin, or run locally without --hands.`,
			);
		}
		throw tooMany(files.length);
	}
	checkSizes(root, files);
	const start = new Map<string, WorkspaceFileStat>();
	for (const path of files) {
		const stat = statOf(root, path);
		if (stat) start.set(path, stat);
	}
	if (files.length === 0) return { root, kind: "empty", upload: [], start, summary: "empty workspace" };
	return {
		root,
		kind: "files",
		upload: files,
		start,
		summary: `${files.length} file${files.length === 1 ? "" : "s"} from ${root}`,
	};
}

/** Uploads the plan's files and returns the run's `workspace`. */
export async function uploadWorkspace(
	client: Pick<HandsClient, "uploadFile">,
	plan: WorkspacePlan,
	options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<HandsWorkspace> {
	const ids: string[] = [];
	let done = 0;
	for (const path of plan.upload) {
		const bytes = readFileSync(join(plan.root, path));
		const digest = createHash("sha256").update(bytes).digest("hex");
		const uploaded = await client.uploadFile(
			{ path, bytes, idempotencyKey: createHash("sha256").update(`${path}\0${digest}`).digest("hex").slice(0, 64) },
			options.signal,
		);
		ids.push(uploaded.id);
		done += 1;
		options.onProgress?.(done, plan.upload.length);
	}
	if (plan.kind === "git") {
		return { type: "git", repo: plan.repo!, ref: plan.ref, ...(ids.length > 0 ? { file_ids: ids } : {}) };
	}
	if (plan.kind === "files") return { type: "files", file_ids: ids };
	return { type: "empty" };
}

/** A path from Hands, checked: relative, `/`-separated, no `.`/`..`/empty segments, never under `.git`. */
export function safeWorkspacePath(raw: unknown): string | undefined {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return undefined;
	const path = raw.replace(/^\.\//, "");
	if (path.startsWith("/") || path.includes("\\") || path.includes("\0") || /^[A-Za-z]:/.test(path)) return undefined;
	const parts = path.split("/");
	if (parts.some((part) => part === "" || part === "." || part === ".." || part === ".git")) return undefined;
	return path;
}

/** True when no segment on the way to `path` (the file itself included) is a symbolic link. */
function noLinkOnTheWay(root: string, path: string): boolean {
	let current = root;
	for (const part of path.split("/")) {
		current = join(current, part);
		try {
			if (lstatSync(current).isSymbolicLink()) return false;
		} catch {
			return true;
		}
	}
	return true;
}

export interface PullBackResult {
	written: string[];
	removed: string[];
	/** Changed locally while the run worked: kept, and the run's version saved at `savedAs` (none when deleted). */
	conflicts: Array<{ path: string; savedAs?: string }>;
	/** Paths Hands named that Fingers would not write (outside the root, through a link, into .git). */
	refused: string[];
}

function changedLocally(plan: WorkspacePlan, path: string): boolean {
	const before = plan.start.get(path);
	const now = statOf(plan.root, path);
	if (!before) return now !== undefined || existsSync(join(plan.root, path));
	if (!now) return true;
	return now.size !== before.size || now.mtimeMs !== before.mtimeMs;
}

/** Writes the run's changes into the plan's root, keeping what the person changed in the meantime. */
export async function pullBack(
	client: Pick<HandsClient, "listChangedFiles" | "fileContent">,
	runId: string,
	plan: WorkspacePlan,
	signal?: AbortSignal,
): Promise<PullBackResult> {
	const result: PullBackResult = { written: [], removed: [], conflicts: [], refused: [] };
	const files: HandsChangedFile[] = await client.listChangedFiles(runId, signal);
	const conflictDir = join(plan.root, HANDS_CONFLICT_DIR, runId.replace(/[^A-Za-z0-9_-]/g, "_"));
	for (const file of files) {
		const path = safeWorkspacePath(file.path);
		const previous = file.previous_path ? safeWorkspacePath(file.previous_path) : undefined;
		if (!path || (file.previous_path && !previous)) {
			result.refused.push(String(file.path).slice(0, 200));
			continue;
		}
		if (!noLinkOnTheWay(plan.root, path) || (previous && !noLinkOnTheWay(plan.root, previous))) {
			result.refused.push(path);
			continue;
		}
		if (file.change === "deleted") {
			if (changedLocally(plan, path)) {
				result.conflicts.push({ path });
				continue;
			}
			rmSync(join(plan.root, path), { force: true });
			result.removed.push(path);
			continue;
		}
		const bytes = await client.fileContent(runId, path, signal);
		if (changedLocally(plan, path) || (previous && changedLocally(plan, previous))) {
			const savedAs = join(conflictDir, path);
			mkdirSync(dirname(savedAs), { recursive: true });
			writeFileSync(savedAs, bytes);
			result.conflicts.push({ path, savedAs: toPosix(relative(plan.root, savedAs)) });
			continue;
		}
		const target = join(plan.root, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, bytes);
		result.written.push(path);
		if (previous && previous !== path) {
			rmSync(join(plan.root, previous), { force: true });
			result.removed.push(previous);
		}
	}
	// What came back is the new start: a follow-up run's conflict check compares against it.
	for (const path of [...result.written, ...result.removed]) {
		const stat = statOf(plan.root, path);
		if (stat) plan.start.set(path, stat);
		else plan.start.delete(path);
	}
	return result;
}

/** True when the root still holds what the last pull-back left (no file the plan knows changed, none appeared). */
export async function unchangedSincePull(plan: WorkspacePlan, git: Git = runGit): Promise<boolean> {
	for (const [path, before] of plan.start) {
		const now = statOf(plan.root, path);
		if (!now || now.size !== before.size || now.mtimeMs !== before.mtimeMs) return false;
	}
	const listed =
		plan.kind === "git" || existsSync(join(plan.root, ".git"))
			? splitZ((await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], plan.root)).stdout)
			: walk(plan.root, MAX_WORKSPACE_FILES * 10);
	return listed.every((path) => plan.start.has(path) || path.startsWith(".fingers/") || !statOf(plan.root, path));
}
