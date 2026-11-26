// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * Sub-agents in the terminal app (F18): registers the engine with the core while the `subagents` feature is on
 * (signed in, Fingers on for the organization, a tier that includes sub-agents) and handles `/agents`.
 *
 * The core's `subagents` extension does the rest: the `agents` tool, the child sessions (same credentials, the
 * parent's settings and approvals) and the cheaper model per child. `/agents` lists this process' sub-agents and can
 * steer or stop one; the full panel (open, approve, pause, checkpoints) is F19. Managed RPC (Hands) keeps ee off;
 * its sub-agent events are F18b.
 */
import type { EeCommandContext, EeHost, SubagentInfo } from "@veyraco/fingers";
import { SubagentEngineImpl, type SubagentEngineOptions } from "./engine.ts";

export { addUsage, emptyUsage, resultText, SubagentEngineImpl, validateSpecs } from "./engine.ts";
export { GitError, nodeGit, runGit, type SubagentGit, WORKTREES_DIR } from "./git.ts";

export const AGENTS_USAGE = "Usage: /agents, /agents steer <id> <message>, /agents stop <id>";

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
	return `${agent.id} ${oneLine(agent.label, 80)} · ${state}${model}${cost}${kept}`;
}

export class Subagents {
	readonly engine: SubagentEngineImpl;

	constructor(options: SubagentEngineOptions = {}) {
		this.engine = new SubagentEngineImpl(options);
	}

	/** Called on every activation while `subagents` is on. */
	attach(host: EeHost): void {
		host.registerSubagentEngine("subagents", this.engine);
		host.registerCommand("agents", (context) => this.command(context));
	}

	command(context: EeCommandContext): void {
		const [verb = "", id = "", ...rest] = context.args.split(/\s+/).filter((part) => part.length > 0);
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
		context.showWarning(AGENTS_USAGE);
	}
}
