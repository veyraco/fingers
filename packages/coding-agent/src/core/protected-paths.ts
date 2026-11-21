/**
 * Files the write and edit tools must ask before changing in the interactive terminal: Fingers' agent
 * directory (global settings with the approval policy, extensions that load at startup, the `rg`/`fd`
 * binaries in `bin/`) and the project's `.fingers` directory (project settings and extensions). The write
 * and edit tools otherwise never ask, so without this a model could switch approvals off or plant code
 * that runs in the next session.
 *
 * Paths are compared after resolving symlinks, including a dangling one (writing through it creates
 * its target), and without regard to case on macOS and Windows, whose file systems usually ignore it.
 */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
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

/**
 * Why writing `filePath` (as the write and edit tools resolve it against `cwd`) must ask, or undefined
 * when it need not.
 */
export function protectedWriteReason(filePath: string, cwd: string, agentDir = getAgentDir()): string | undefined {
	const targets = spellings(resolveToCwd(filePath, cwd));
	const inside = (directory: string) =>
		spellings(directory).some((root) => targets.some((target) => isInside(target, root)));
	if (inside(agentDir)) {
		return "Fingers' own directory: its settings, extensions and the programs it runs.";
	}
	if (inside(join(cwd, CONFIG_DIR_NAME))) {
		return "This project's Fingers settings and extensions.";
	}
	return undefined;
}
