/**
 * Files the write and edit tools must ask before changing in the interactive terminal.
 *
 * protectedWriteReason: Fingers' agent directory (global settings with the approval policy, extensions
 * that load at startup, the `rg`/`fd` binaries in `bin/`), the project's `.fingers` directory (project
 * settings and extensions), the shell startup files in the home directory and in `$ZDOTDIR`, and the
 * files `BASH_ENV`, `ENV` and `RIPGREP_CONFIG_PATH` name. Without this a model could switch approvals off
 * or plant code that runs in the next session or behind a built-in command such as `rg foo`. These ask
 * wherever they are, also inside the working directory (Fingers started in the home directory).
 *
 * writeApprovalReason adds the rest of the rule: any file outside the working directory asks (the
 * temporary directory is exempt), and so does a file with other hard links, since a write changes them
 * too.
 *
 * Paths are compared after resolving symlinks, including a dangling one (writing through it creates
 * its target), and without regard to case on macOS and Windows, whose file systems usually ignore it.
 */
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { resolveToCwd } from "./tools/path-utils.ts";

const MAX_SYMLINK_HOPS = 40;

/** `path` with every symlink resolved, for the part of it that exists; the rest is appended as written. */
function resolveExisting(path: string, hops = 0): string {
	try {
		return realpathSync.native(path);
	} catch {
		// Missing, or a dangling symlink somewhere along the path.
	}
	if (hops < MAX_SYMLINK_HOPS) {
		try {
			if (lstatSync(path).isSymbolicLink()) {
				return resolveExisting(resolve(dirname(path), readlinkSync(path)), hops + 1);
			}
		} catch {
			// The path does not exist: resolve its parent.
		}
	}
	const parent = dirname(path);
	if (parent === path) return path;
	return join(resolveExisting(parent, hops), basename(path));
}

function comparable(path: string): string {
	return process.platform === "darwin" || process.platform === "win32" ? path.toLowerCase() : path;
}

function isInside(path: string, directory: string): boolean {
	const child = comparable(path);
	const parent = comparable(directory);
	return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Both spellings of a path: as written (absolute) and with symlinks resolved. */
function spellings(path: string): string[] {
	const absolute = resolve(path);
	return [absolute, resolveExisting(absolute)];
}

/** Startup files bash, sh and zsh read from the home directory; zsh's also from `$ZDOTDIR`. */
const HOME_STARTUP_FILES = [
	".bashrc",
	".bash_profile",
	".bash_login",
	".bash_logout",
	".profile",
	".zshenv",
	".zprofile",
	".zshrc",
	".zlogin",
	".zlogout",
];
const ZSH_STARTUP_FILES = [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"];

/** Environment variables that name a file a shell or a built-in command reads as code or options. */
const ENV_NAMED_FILES: ReadonlyArray<{ name: string; reads: string }> = [
	{ name: "BASH_ENV", reads: "bash runs it" },
	{ name: "ENV", reads: "sh runs it" },
	{ name: "RIPGREP_CONFIG_PATH", reads: "rg reads its options from it" },
];

/** `$HOME`/`${HOME}`/a leading `~` expanded; a value with any other `$` gives undefined. */
function expandEnvPath(value: string, home: string): string | undefined {
	const expanded = value.replace(/^~(?=$|[\\/])/, home).replace(/\$\{HOME\}|\$HOME\b/g, home);
	if (expanded.includes("$")) return undefined;
	return resolve(expanded);
}

interface WriteApprovalOptions {
	/** Fingers' agent directory (default: getAgentDir()). */
	agentDir?: string;
	/** The environment whose `HOME`, `ZDOTDIR`, `BASH_ENV`, `ENV` and `RIPGREP_CONFIG_PATH` count (default: process.env). */
	env?: NodeJS.ProcessEnv;
	/** The temporary directory, where writes need not ask (default: os.tmpdir()). */
	tempDir?: string;
}

/**
 * Why writing `filePath` (as the write and edit tools resolve it against `cwd`) must ask wherever the
 * file is, or undefined when it need not: Fingers' own files and the shell startup and config files.
 */
export function protectedWriteReason(
	filePath: string,
	cwd: string,
	agentDir = getAgentDir(),
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const targets = spellings(resolveToCwd(filePath, cwd));
	const inside = (directory: string) =>
		spellings(directory).some((root) => targets.some((target) => isInside(target, root)));
	if (inside(agentDir)) {
		return "Fingers' own directory: its settings, extensions and the programs it runs.";
	}
	if (inside(join(cwd, CONFIG_DIR_NAME))) {
		return "This project's Fingers settings and extensions.";
	}
	const home = env.HOME || homedir();
	const zdotdir = env.ZDOTDIR || home;
	const startupFiles = [
		...HOME_STARTUP_FILES.map((name) => join(home, name)),
		...ZSH_STARTUP_FILES.map((name) => join(zdotdir, name)),
	];
	if (startupFiles.some(inside)) {
		return "A shell startup file: shells run it, and so would the commands that run without asking.";
	}
	for (const { name, reads } of ENV_NAMED_FILES) {
		const value = env[name];
		const named = value ? expandEnvPath(value, home) : undefined;
		if (named && inside(named)) return `The file ${name} names: ${reads}.`;
	}
	return undefined;
}

/**
 * The temporary directory, unless it is the file system root, the home directory or one of its
 * ancestors: then exempting it would exempt the home directory's files.
 */
function usableTempDir(tempDir: string, home: string): string | undefined {
	const temp = spellings(tempDir);
	if (temp.some((path) => parse(path).root === path)) return undefined;
	if (spellings(home).some((path) => temp.some((root) => isInside(path, root)))) return undefined;
	return tempDir;
}

/** Whether every spelling of `path` lies inside the working directory or the temporary directory. */
function insideWorkArea(path: string, cwd: string, tempDir: string | undefined): boolean {
	const roots = [...spellings(cwd), ...(tempDir ? spellings(tempDir) : [])];
	return spellings(path).every((spelling) => roots.some((root) => isInside(spelling, root)));
}

function hasOtherHardLinks(path: string): boolean {
	try {
		const stats = statSync(path);
		return stats.isFile() && stats.nlink > 1;
	} catch {
		return false;
	}
}

/**
 * Why the write or edit tool must ask before writing `filePath` in the interactive terminal, or
 * undefined when it need not: a protected file (protectedWriteReason), any file outside the working
 * directory except in the temporary directory (symlinks resolved), or a file with other hard links.
 */
export function writeApprovalReason(
	filePath: string,
	cwd: string,
	options: WriteApprovalOptions = {},
): string | undefined {
	const env = options.env ?? process.env;
	const protectedReason = protectedWriteReason(filePath, cwd, options.agentDir ?? getAgentDir(), env);
	if (protectedReason) return protectedReason;
	const target = resolveToCwd(filePath, cwd);
	const tempDir = usableTempDir(options.tempDir ?? tmpdir(), env.HOME || homedir());
	if (!insideWorkArea(target, cwd, tempDir)) {
		return "Outside this project's folder.";
	}
	if (hasOtherHardLinks(resolveExisting(resolve(target)))) {
		return "This file has other hard links: changing it changes them too.";
	}
	return undefined;
}

/**
 * The first PATH entry in `env` where the write tool could put a program without asking: an empty or
 * relative entry (it follows the shell's working directory), or one inside the working directory or the
 * temporary directory. While there is one, built-in commands must ask, since `ls` could resolve to a
 * planted file. Undefined when there is none.
 *
 * A `~/…` entry is relative too (zsh and dash look in a folder named `~` under the working directory)
 * unless `tildeExpands`: bash expands it to the home directory.
 */
export function pathEntryWritableWithoutAsking(
	cwd: string,
	env: NodeJS.ProcessEnv,
	options: Pick<WriteApprovalOptions, "tempDir"> & { tildeExpands?: boolean } = {},
): string | undefined {
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
	const value = pathKey === undefined ? undefined : env[pathKey];
	if (value === undefined) return undefined;
	const home = env.HOME || homedir();
	const tempDir = usableTempDir(options.tempDir ?? tmpdir(), home);
	return value.split(delimiter).find((entry) => {
		const tilde = /^~(?=$|[\\/])/.test(entry);
		if (tilde && !options.tildeExpands) return true;
		const directory = tilde ? home + entry.slice(1) : entry;
		if (directory === "" || !isAbsolute(directory)) return true;
		return spellings(directory).some((spelling) => insideWorkArea(spelling, cwd, tempDir));
	});
}
