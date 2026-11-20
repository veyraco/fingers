/**
 * Managed mode's path gate for the built-in file tools, ported from Hands' Pi runtime extension
 * (`checkPiNativeTool`). Every candidate path a tool could touch is expanded exactly as the tools expand it
 * (`resolveToCwd`, plus the read tool's filename fallbacks), every existing ancestor is resolved through
 * symlinks, and the call is refused unless the result stays inside the workspace and outside every protected
 * path. Shell commands are not checked here: the host sandbox stays authoritative for them.
 */
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { resolveToCwd } from "../../../core/tools/path-utils.ts";

export interface PathPolicyInput {
	workspaceRoot: string;
	protectedPaths: readonly string[];
}

export interface PathPolicy {
	/** The workspace root as configured (logical) and resolved (physical). */
	workspace: { logical: string; physical: string };
	protectedRoots: Array<{ logical: string; physical: string }>;
}

export const READ_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);
export const WRITE_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

function inside(root: string, target: string): boolean {
	const suffix = relative(root, target);
	return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

/** Resolve every existing ancestor, including symlinks, of a path that may not exist yet. */
async function physicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
		return resolve(await physicalPath(dirname(path)), relative(dirname(path), path));
	}
}

/** Check the configured roots once, at `configure`. Throws when the workspace is unusable. */
export async function preparePathPolicy(input: PathPolicyInput): Promise<PathPolicy> {
	const logical = resolve(input.workspaceRoot);
	let physical: string;
	try {
		physical = await realpath(logical);
		if (!(await stat(physical)).isDirectory()) throw new Error("not a directory");
	} catch (error) {
		throw new Error(`workspace.root is not a directory: ${logical} (${(error as Error).message})`);
	}
	const protectedRoots: PathPolicy["protectedRoots"] = [];
	for (const path of input.protectedPaths) {
		const root = { logical: resolve(path), physical: await physicalPath(resolve(path)) };
		if (inside(root.logical, logical) || inside(root.physical, physical)) {
			throw new Error(`workspace.root lies inside the protected path ${root.logical}`);
		}
		protectedRoots.push(root);
	}
	return { workspace: { logical, physical }, protectedRoots };
}

/** Every path the tool could select for `value`: the read tool also tries macOS filename variants. */
export function managedToolPathCandidates(value: string, cwd: string, read: boolean): string[] {
	const path = resolveToCwd(value, cwd);
	if (!read) return [path];
	const nfd = path.normalize("NFD");
	return [
		...new Set([path, path.replace(/ (AM|PM)\./gi, " $1."), nfd, path.replace(/'/g, "’"), nfd.replace(/'/g, "’")]),
	];
}

/**
 * Why the call may not run, or null when its paths are allowed. Tools without a path argument (bash, MCP
 * tools) return null: their effects are the host sandbox's and the approval policy's business.
 */
export async function checkManagedToolPaths(
	toolName: string,
	input: Record<string, unknown>,
	policy: PathPolicy,
): Promise<string | null> {
	const isRead = READ_TOOLS.has(toolName);
	if (!isRead && !WRITE_TOOLS.has(toolName)) return null;
	const value = input.path ?? (isRead && toolName !== "read" ? "." : undefined);
	if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/.test(value)) return "Tool path is invalid";
	let candidates: string[];
	try {
		candidates = managedToolPathCandidates(value, policy.workspace.logical, toolName === "read");
	} catch {
		return "Tool path is invalid";
	}
	for (const logical of candidates) {
		let target: string;
		try {
			target = await physicalPath(logical);
		} catch {
			return "Tool path cannot be resolved";
		}
		for (const root of policy.protectedRoots) {
			if (inside(root.logical, logical) || inside(root.physical, target)) {
				return "Tool path targets protected runtime state";
			}
		}
		const logicalInside = inside(policy.workspace.logical, logical) || inside(policy.workspace.physical, logical);
		if (!logicalInside || !inside(policy.workspace.physical, target)) {
			return "Tool path is outside the workspace";
		}
	}
	return null;
}
