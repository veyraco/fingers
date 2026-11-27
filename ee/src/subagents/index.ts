// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * Sub-agents in the terminal app: registers the engine with the core while the `subagents` feature is on
 * (signed in, Fingers on for the organization, a tier that includes sub-agents) and handles `/agents`.
 *
 * The core's `subagents` extension does the rest: the `agents` tool, the child sessions (same credentials, the
 * parent's settings and approvals) and the cheaper model per child. `/agents` opens the core's sub-agents panel
 * (open, approve, steer, pause, stop, checkpoint, resume) where the terminal app has one, else lists this
 * process' sub-agents; the text forms (`/agents steer <id> <message>` and the others in AGENTS_USAGE) act on one.
 * Checkpoints are their own feature (`checkpoints`): the engine asks it before every checkpoint and roll-back.
 * Managed RPC (Hands) activates this module with only `subagents` (modes/rpc/managed/subagents.ts in the core).
 */
import type { EeCommandContext, EeHost, SubagentInfo } from "@veyraco/fingers";
import { SubagentEngineImpl, type SubagentEngineOptions } from "./engine.ts";

export {
	addUsage,
	emptyUsage,
	MAX_CHECKPOINTS_PER_AGENT,
	resultText,
	SubagentActionError,
	SubagentEngineImpl,
	validateSpecs,
} from "./engine.ts";
export { GitError, nodeGit, runGit, type SubagentGit, WORKTREES_DIR } from "./git.ts";

export const AGENTS_USAGE =
	"Usage: /agents, /agents steer <id> <message>, /agents pause <id>, /agents resume <id> [cp-N], /agents checkpoint <id>, /agents stop <id>, /agents remove <id>";

function formatUsd(usd: number): string {
	return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** One line of text without terminal escapes. */
function oneLine(text: string, max = 200): string {
	const flat = text
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function agentListLine(agent: SubagentInfo): string {
	const model = agent.model ? ` · ${agent.model.id}` : "";
	const cost = ` · ${formatUsd(agent.usage.cost.total)}`;
	let state = agent.status.replace("_", " ");
	if (agent.status === "done")
		state = agent.merged ? `done, merged (${agent.filesChanged ?? 0} files)` : "done, not merged";
	const kept = agent.keptWorktree ? ` · kept in ${agent.keptWorktree}` : "";
	const checkpoints = agent.checkpoints?.length
		? ` · checkpoints ${agent.checkpoints.map((checkpoint) => checkpoint.id).join(", ")}`
		: "";
	return `${agent.id} ${oneLine(agent.label, 80)} · ${state}${model}${cost}${kept}${checkpoints}`;
}

export class Subagents {
	readonly engine: SubagentEngineImpl;

	constructor(options: SubagentEngineOptions = {}) {
		this.engine = new SubagentEngineImpl(options);
	}

	/** Called on every activation while `subagents` is on. */
	attach(host: EeHost): void {
		this.engine.setCheckpointsGate(() => host.isOn("checkpoints"));
		host.registerSubagentEngine("subagents", this.engine);
		host.registerCommand("agents", (context) => this.command(context));
	}

	async command(context: EeCommandContext): Promise<void> {
		const [verb = "", id = "", ...rest] = context.args.split(/\s+/).filter((part) => part.length > 0);
		const act = async (action: () => Promise<string>) => {
			try {
				context.showStatus(await action());
			} catch (error) {
				context.showWarning(error instanceof Error ? error.message : String(error));
			}
		};
		if (verb === "" && context.openAgentsPanel) {
			context.openAgentsPanel();
			return;
		}
		if (verb === "") {
			const agents = this.engine.list();
			if (agents.length === 0) {
				context.showStatus(
					"No sub-agents yet in this session. Ask for work that splits into independent parts; the agent starts sub-agents with its agents tool.",
				);
				return;
			}
			const total = agents.reduce((sum, agent) => sum + agent.usage.cost.total, 0);
			context.showStatus(
				[
					`Sub-agents (${agents.length}, ${formatUsd(total)}):`,
					...agents.map((agent) => `  ${agentListLine(agent)}`),
				].join("\n"),
			);
			return;
		}
		if (verb === "steer") {
			const message = rest.join(" ").trim();
			if (!id || !message) {
				context.showWarning(AGENTS_USAGE);
				return;
			}
			if (this.engine.steer(id, message))
				context.showStatus(`Sent to ${id}; it reads it before its next model call.`);
			else context.showWarning(`${id} is not running.`);
			return;
		}
		if (verb === "stop") {
			if (!id) {
				context.showWarning(AGENTS_USAGE);
				return;
			}
			if (this.engine.stop(id)) context.showStatus(`Stopping ${id}.`);
			else context.showWarning(`${id} is not running or queued.`);
			return;
		}
		if (!id || !["pause", "resume", "checkpoint", "remove"].includes(verb)) {
			context.showWarning(AGENTS_USAGE);
			return;
		}
		if (verb === "pause") {
			if (this.engine.pause(id)) context.showStatus(`Pausing ${id}: it holds before its next model call.`);
			else context.showWarning(`${id} is not running.`);
			return;
		}
		if (verb === "resume") {
			const checkpoint = rest[0];
			await act(async () => {
				await this.engine.resume(id, checkpoint);
				return checkpoint ? `${id} goes on from ${checkpoint}.` : `${id} goes on.`;
			});
			return;
		}
		if (verb === "checkpoint") {
			context.showStatus(`Keeping a checkpoint of ${id} at its next model call…`);
			await act(async () => {
				const checkpoint = await this.engine.checkpoint(id);
				return `Kept ${checkpoint.id} of ${id} (${checkpoint.filesChanged ?? 0} files changed). Resume from it with /agents resume ${id} ${checkpoint.id} while ${id} is paused.`;
			});
			return;
		}
		await act(async () => {
			await this.engine.removeWorktree(id);
			return `Removed the worktree ${id} kept.`;
		});
	}
}
