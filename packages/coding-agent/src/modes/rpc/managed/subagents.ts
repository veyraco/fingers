/**
 * Sub-agents in managed RPC mode (contracts/v1/fingers-rpc.md, Sub-agents, amendment 2026-11-27).
 *
 * The engine is an ee feature. In the terminal app the ee gate turns it on from the signed-in organization's tier;
 * a managed process has no sign-in: the host (Hands) decides from the organization's entitlement and says so with
 * `configure.subagents.enabled`. So managed mode activates the ee module with a host on which only `subagents` is
 * on (and `checkpoints` while `configure.checkpoints.dir` is set), takes the engine the module registers, and
 * registers nothing else: no token saving, Brain, Eyes, commands or tool hooks run in managed mode.
 *
 * The engine puts each child's worktree under the repository root; managed Fingers never writes outside
 * `workspace.root`, so a call whose repository root lies outside it is refused before anything is written.
 */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { EE_API_VERSION, type EeEntitlement, type EeHost, type EeModule } from "../../../core/edition/types.ts";
import type { SubagentEngine } from "../../../core/subagents/types.ts";
import { inside } from "./path-policy.ts";

/** What the ee module sees as the entitlement in managed mode: the host decided, no person is signed in. */
const MANAGED_ENTITLEMENT: EeEntitlement = Object.freeze({
	signedIn: false,
	source: "none",
	fingersEnabled: true,
});

/**
 * The ee module's sub-agent engine for managed mode, or undefined when this build has no ee module (core only) or
 * the module registers none. `checkpointsOn` is asked before every sub-agent checkpoint and roll-back.
 */
export function managedSubagentEngine(
	module: EeModule | undefined,
	checkpointsOn: () => boolean,
): SubagentEngine | undefined {
	if (!module) return undefined;
	let engine: SubagentEngine | undefined;
	const host: EeHost = {
		apiVersion: EE_API_VERSION,
		entitlement: MANAGED_ENTITLEMENT,
		isOn: (feature) => feature === "subagents" || (feature === "checkpoints" && checkpointsOn()),
		registerCommand: () => {},
		registerToolHooks: () => {},
		recordSaving: () => {},
		registerMemoryProvider: () => {},
		registerTelemetryExporter: () => {},
		registerSubagentEngine: (feature, registered) => {
			if (feature === "subagents") engine = registered;
		},
		createOtlpExporter: () => {
			throw new Error("Managed mode sends no telemetry of its own");
		},
		veyraApi: () => undefined,
	};
	try {
		module.activate(host);
	} catch {
		return undefined;
	}
	return engine;
}

/** Variables that would point git at another repository than the one the directory is in. */
const REPOSITORY_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"];

/** The repository root of `cwd`, resolved through symlinks; undefined outside a repository (or without git). */
export function repositoryRoot(cwd: string): Promise<string | undefined> {
	const env = { ...process.env };
	for (const name of REPOSITORY_VARIABLES) delete env[name];
	return new Promise((resolve) => {
		execFile("git", ["rev-parse", "--show-toplevel"], { cwd, env, timeout: 15_000 }, (error, stdout) => {
			const root = String(stdout ?? "").trim();
			if (error || !root) {
				resolve(undefined);
				return;
			}
			realpath(root).then(resolve, () => resolve(undefined));
		});
	});
}

export const REPOSITORY_OUTSIDE_WORKSPACE =
	"Sub-agents need the whole git repository inside the workspace: its root lies outside workspace.root, so no sub-agent was started.";

/**
 * The engine, refusing a call whose repository root is outside the workspace (the worktrees would be written there).
 * Outside a repository the engine itself refuses the call. `onRoot` hears the root of each call that runs.
 */
export function workspaceBoundEngine(
	engine: SubagentEngine,
	workspacePhysical: () => string,
	onRoot?: (root: string) => void,
): SubagentEngine {
	return {
		async run(request, host) {
			const root = await repositoryRoot(host.cwd);
			if (root && !inside(workspacePhysical(), root)) throw new Error(REPOSITORY_OUTSIDE_WORKSPACE);
			if (root) onRoot?.(root);
			return engine.run(request, host);
		},
		steer: (id, text) => engine.steer(id, text),
		stop: (id) => engine.stop(id),
		list: () => engine.list(),
		pause: (id) => engine.pause(id),
		resume: (id, checkpoint) => engine.resume(id, checkpoint),
		checkpoint: (id) => engine.checkpoint(id),
		transcript: (id) => engine.transcript(id),
		removeWorktree: (id) => engine.removeWorktree(id),
	};
}
