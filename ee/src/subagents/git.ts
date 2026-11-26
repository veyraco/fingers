// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * The git work of sub-agents: each child gets a worktree of the repository under `<root>/.fingers/worktrees/<id>`,
 * checked out at a snapshot of the parent's working tree (tracked changes and new files that are not ignored, so a
 * child sees the parent's unfinished work), and a finished child's changes come back as a binary patch applied to
 * the parent's working tree. None of this touches the parent's index, branch, HEAD or stash: the snapshot is built
 * in a temporary index and is a commit no branch points to.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";

/** Where the worktrees go, relative to the repository root. */
export const WORKTREES_DIR = join(".fingers", "worktrees");

/** Commits the snapshot is made with (never the person's identity, and no git configuration needed). */
const SNAPSHOT_IDENTITY = {
	GIT_AUTHOR_NAME: "Fingers",
	GIT_AUTHOR_EMAIL: "fingers@veyra.invalid",
	GIT_COMMITTER_NAME: "Fingers",
	GIT_COMMITTER_EMAIL: "fingers@veyra.invalid",
};

/** Variables that would point git at another repository, index or work tree than the one named. */
const REPOSITORY_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"];

export class GitError extends Error {
	readonly stderr: string;

	constructor(message: string, stderr: string) {
		super(message);
		this.name = "GitError";
		this.stderr = stderr;
	}
}

export interface GitRunOptions {
	cwd: string;
	env?: Record<string, string>;
	input?: string | Buffer;
	signal?: AbortSignal;
}

/** Runs git and resolves with its standard output; rejects with its standard error when it fails. */
export function runGit(args: readonly string[], options: GitRunOptions): Promise<string> {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const name of REPOSITORY_VARIABLES) delete env[name];
	Object.assign(env, { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, options.env);
	return new Promise((resolve, reject) => {
		const child = spawn("git", [...args], {
			cwd: options.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			signal: options.signal,
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		child.on("error", (error) => reject(error));
		child.on("close", (code) => {
			const stdout = Buffer.concat(out).toString("utf8");
			const stderr = Buffer.concat(err).toString("utf8").trim();
			if (code === 0) resolve(stdout);
			else reject(new GitError(`git ${args[0]} failed: ${stderr || `exit ${code}`}`, stderr));
		});
		child.stdin.on("error", () => {});
		child.stdin.end(options.input ?? "");
	});
}

/** The git operations the engine needs; tests may replace them. */
export interface SubagentGit {
	/** The repository's root, symlinks resolved; rejects outside a repository. */
	root(cwd: string): Promise<string>;
	/** Makes `<root>/.fingers/worktrees` and keeps it out of git (its own `.gitignore`). */
	prepare(root: string): Promise<void>;
	/** A commit of the working tree as it is now (tracked and new files that are not ignored). */
	snapshot(root: string): Promise<string>;
	/** Checks out `commit` into a new detached worktree at `path`. */
	addWorktree(root: string, path: string, commit: string): Promise<void>;
	/** What the worktree changed since `base`: the files and a binary patch (empty when nothing changed). */
	changes(path: string, base: string): Promise<{ files: string[]; patch: string }>;
	/** Applies a patch to the working tree at `root` (all or nothing); rejects when it does not apply. */
	apply(root: string, patch: string): Promise<void>;
	/** Removes the worktree and its administrative files. */
	removeWorktree(root: string, path: string): Promise<void>;
}

export const nodeGit: SubagentGit = {
	async root(cwd) {
		let top: string;
		try {
			top = (await runGit(["rev-parse", "--show-toplevel"], { cwd })).trim();
		} catch {
			throw new Error(
				`Sub-agents need a git repository: ${cwd} is not inside one. Run \`git init\` there first, or do the work without sub-agents.`,
			);
		}
		return realpathSync.native(top);
	},

	async prepare(root) {
		const dir = join(root, WORKTREES_DIR);
		mkdirSync(dir, { recursive: true });
		const ignore = join(dir, ".gitignore");
		// Ignores everything in it, itself included, so the worktrees never show up in the parent's `git status`.
		if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
	},

	async snapshot(root) {
		const scratch = mkdtempSync(join(tmpdir(), "fingers-snapshot-"));
		try {
			const env = { GIT_INDEX_FILE: join(scratch, "index"), ...SNAPSHOT_IDENTITY };
			const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: root }).then(
				(out) => out.trim(),
				() => undefined,
			);
			await runGit(head ? ["read-tree", head] : ["read-tree", "--empty"], { cwd: root, env });
			await runGit(["add", "--all", "--", "."], { cwd: root, env });
			const tree = (await runGit(["write-tree"], { cwd: root, env })).trim();
			const parent = head ? ["-p", head] : [];
			const message = "Fingers sub-agent base (the working tree when the sub-agent started)";
			// Never signed (commit.gpgSign would ask for a key) and never the person's identity.
			return (
				await runGit(["commit-tree", "--no-gpg-sign", tree, ...parent, "-m", message], { cwd: root, env })
			).trim();
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	},

	async addWorktree(root, path, commit) {
		// No hooks: a post-checkout hook of the repository (LFS, husky) is not the sub-agent's to run.
		await runGit(["-c", `core.hooksPath=${devNull}`, "worktree", "add", "--detach", "--quiet", path, commit], {
			cwd: root,
		});
	},

	async changes(path, base) {
		await runGit(["add", "--all", "--", "."], { cwd: path });
		const names = await runGit(["diff", "--cached", "--name-only", "-z", base], { cwd: path });
		const files = names.split("\0").filter((name) => name.length > 0);
		if (files.length === 0) return { files, patch: "" };
		// Explicit prefixes: `git apply` strips one level whatever diff.noprefix or diff.mnemonicPrefix say.
		const patch = await runGit(
			[
				"diff",
				"--cached",
				"--binary",
				"--no-color",
				"--no-ext-diff",
				"--no-renames",
				"--src-prefix=a/",
				"--dst-prefix=b/",
				base,
			],
			{ cwd: path },
		);
		return { files, patch };
	},

	async apply(root, patch) {
		await runGit(["apply", "--binary", "--whitespace=nowarn", "-"], { cwd: root, input: patch });
	},

	async removeWorktree(root, path) {
		try {
			await runGit(["worktree", "remove", "--force", path], { cwd: root });
		} catch {
			rmSync(path, { recursive: true, force: true });
			await runGit(["worktree", "prune"], { cwd: root }).catch(() => undefined);
		}
	},
};
