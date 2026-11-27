/**
 * Open core: the built-in extension through which a sub-agent engine (an ee feature, F18) acts on the terminal app's
 * sessions. It is MIT and holds no engine: it offers the model the `agents` tool while the process' engine is live
 * (core/subagents/registry.ts, filled by the ee gate), makes the child sessions the engine asks for (child-session.ts),
 * picks each child's model (a cheaper one when the ee routing rule finds one, F16), and turns the children's usage
 * into the tool result's usage, so the session's cost, the status line, `/budget` and `/savings` count every child.
 * A child's spend counts toward the session's budget while it runs: the engine stops the children once the budget
 * is reached, and a call made when it is already reached starts none. Calls of one answer run one after the other. With no engine (core only, signed out, a tier without sub-agents, print and JSON modes, managed RPC without
 * `configure.subagents`) the tool is not offered and nothing changes.
 *
 * Managed RPC (F18b) loads it with its own engines, the run's limits in place of the budget and its own child hooks
 * (the host's gate and tools, records forwarded with the child's id).
 */
import type { Api, Model } from "@veyraco/fingers-ai";
import { type Static, Type } from "typebox";
import { costCapReached } from "../../core/budget.ts";
import { type EditionToolHooks, editionToolHooks } from "../../core/edition/tool-hooks.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../core/extensions/types.ts";
import { routeOutcome, routeSubTask } from "../../core/model-routing.ts";
import { type SubagentEngines, subagentEngines } from "../../core/subagents/registry.ts";
import {
	MAX_SUBAGENT_LABEL_CHARS,
	MAX_SUBAGENT_TASK_CHARS,
	MAX_SUBAGENTS_PER_CALL,
	SUBAGENT_KINDS,
	type SubagentInfo,
	type SubagentRunHost,
} from "../../core/subagents/types.ts";
import type { AskForApproval } from "../approvals/index.ts";
import { ApprovalQueue, type ChildSessionHooks, createChildSession } from "./child-session.ts";

export const AGENTS_TOOL = "agents";

/** The context a child needs at least, and the output it may write, for routing to pick a model. */
const CHILD_MIN_CONTEXT_TOKENS = 64_000;
const CHILD_MIN_OUTPUT_TOKENS = 8_192;

const agentsSchema = Type.Object({
	start: Type.Array(
		Type.Object({
			label: Type.String({
				minLength: 1,
				maxLength: MAX_SUBAGENT_LABEL_CHARS,
				description: "A short name for this sub-agent, unique in this call (e.g. checkout-port)",
			}),
			task: Type.String({
				minLength: 1,
				maxLength: MAX_SUBAGENT_TASK_CHARS,
				description:
					"The sub-agent's whole task: what to change or find, which files or areas, and what done means. It sees only this text, not the conversation.",
			}),
			kind: Type.Optional(
				Type.Union(
					SUBAGENT_KINDS.map((kind) => Type.Literal(kind)),
					{
						description:
							"code (default): change code; search: look things up and report; review: check work and report",
					},
				),
			),
			depends_on: Type.Optional(
				Type.Array(Type.String({ minLength: 1, maxLength: MAX_SUBAGENT_LABEL_CHARS }), {
					description: "Labels of sub-agents of this call that must finish (and be merged) before this one starts",
				}),
			),
		}),
		{ minItems: 1, maxItems: MAX_SUBAGENTS_PER_CALL },
	),
});

export type AgentsToolParams = Static<typeof agentsSchema>;

export interface AgentsToolDetails {
	agents: SubagentInfo[];
}

export interface SubagentsExtensionOptions {
	/** Default: this process' engine, which the terminal app's gate fills. */
	engines?: SubagentEngines;
	/** Default: this process' ee tool hooks (cheaper-model routing). */
	hooks?: EditionToolHooks;
	/** How a child asks the person (default: the approval box in the parent's terminal). */
	ask?: AskForApproval;
	/** Default: the agent directory. */
	agentDir?: string;
	/**
	 * In place of the session's cost budget (managed RPC: a limit of the run is reached). Asked before a call starts
	 * children and before each child starts and after each of its model calls; the host counts the children's spend
	 * itself.
	 */
	limitReached?: () => boolean;
	/** A host's own gate, tools and watcher for each child (managed RPC). */
	child?: ChildSessionHooks;
}

function formatUsd(usd: number): string {
	return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** One line per sub-agent, for the tool's progress and the `/agents` list. */
export function subagentLine(agent: SubagentInfo): string {
	const model = agent.model ? ` · ${agent.model.id}` : "";
	const cost = agent.usage.cost.total > 0 ? ` · ${formatUsd(agent.usage.cost.total)}` : "";
	const waits =
		agent.status === "queued" && agent.dependsOn.length > 0 ? ` · waits for ${agent.dependsOn.join(", ")}` : "";
	return `${agent.id} ${agent.label} · ${agent.status.replace("_", " ")}${model}${cost}${waits}`;
}

export function createSubagentsExtension(options: SubagentsExtensionOptions = {}): ExtensionFactory {
	const engines = options.engines ?? subagentEngines;
	const hooks = options.hooks ?? editionToolHooks;
	const approvalQueue = new ApprovalQueue();
	return (fingers: ExtensionAPI) => {
		fingers.registerTool<typeof agentsSchema, AgentsToolDetails>({
			name: AGENTS_TOOL,
			label: "agents",
			description:
				"Start sub-agents that work in parallel, each in its own git worktree of this repository, on a cheaper model where one fits. The call waits until every sub-agent has finished, then each finished sub-agent's file changes are merged into the working tree. A sub-agent with depends_on starts after those have finished and been merged. A sub-agent that fails does not stop the others.",
			promptSnippet: "Split independent parts of a task across sub-agents that work in parallel",
			promptGuidelines: [
				`Use ${AGENTS_TOOL} when a task splits into parts that change different files (or into look-ups that can run side by side); give each sub-agent its whole task, since it does not see this conversation.`,
				`Do small or tightly coupled changes yourself instead of using ${AGENTS_TOOL}; after it returns, check the merged changes and finish what a failed or stopped sub-agent left.`,
			],
			parameters: agentsSchema,
			defaultActive: false,
			// Two `agents` calls of one answer run one after the other, so the second sees what the first one's
			// children spent (each call counts only its own children toward the budget) and no more than one call's
			// children run at once.
			executionMode: "sequential",
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const engine = engines.engine();
				if (!engine) {
					return {
						content: [{ type: "text", text: "Sub-agents are off for this sign-in; do the work yourself." }],
						details: { agents: [] },
						isError: true,
					};
				}
				// The answer that asked for sub-agents may itself have reached the budget: start none.
				const budget = options.limitReached ? undefined : engines.budget();
				if (options.limitReached?.() || (budget && costCapReached(budget.spentUsd, budget.capUsd))) {
					return {
						content: [
							{
								type: "text",
								text: options.limitReached
									? "A limit of this run is reached, so no sub-agents were started. Stop here."
									: "The session's budget is reached, so no sub-agents were started. Stop here and tell the person.",
							},
						],
						details: { agents: [] },
						isError: true,
					};
				}
				const parentModel = ctx.model as Model<Api> | undefined;
				const runtime = ctx.modelRegistry.modelRuntime;
				const settings = fingers.getSettings();
				const live = new Map<string, SubagentInfo>();
				const progress = () => {
					if (!onUpdate) return;
					const agents = [...live.values()];
					onUpdate({
						content: [{ type: "text", text: agents.map(subagentLine).join("\n") }],
						details: { agents },
					});
				};
				const routingLines = (agent: SubagentInfo): string[] => {
					if (!parentModel || !agent.model) return [];
					if (agent.model.provider === parentModel.provider && agent.model.id === parentModel.id) return [];
					const to = runtime.getModel(agent.model.provider, agent.model.id);
					if (!to) return [];
					const taskClass = agent.kind === "search" ? "search" : "review";
					return hooks.afterRoute(routeOutcome(taskClass, parentModel, to, agent.usage));
				};
				const host: SubagentRunHost = {
					cwd: ctx.cwd,
					signal: signal ?? new AbortController().signal,
					pickModel(kind) {
						if (!parentModel) return undefined;
						const routed = routeSubTask({
							taskClass: kind === "search" ? "search" : "review",
							model: parentModel,
							models: runtime,
							minContextTokens: Math.min(parentModel.contextWindow, CHILD_MIN_CONTEXT_TOKENS),
							minOutputTokens: Math.min(parentModel.maxTokens, CHILD_MIN_OUTPUT_TOKENS),
							hooks,
						});
						const model = routed ?? parentModel;
						return { provider: model.provider, id: model.id };
					},
					startChild: (child) =>
						createChildSession(child, {
							modelRuntime: runtime,
							settings,
							thinkingLevel: ctx.thinkingLevel,
							mode: ctx.mode,
							ui: ctx.ui,
							parent: ctx,
							ask: options.ask,
							agentDir: options.agentDir,
							approvalQueue,
							approvalDesk: engines.approvals,
							hooks: options.child,
						}),
					report(event) {
						live.set(event.agent.id, event.agent);
						engines.emit(event);
						progress();
						if (event.type !== "subagent_finished" || event.agent.status !== "done") return;
						// A child on a cheaper model: what routing saved goes to the savings ledger like a routed summary.
						const lines = routingLines(event.agent);
						if (ctx.hasUI) for (const line of lines) ctx.ui.notify(line, "info");
					},
					budgetReached(childrenCostUsd) {
						if (options.limitReached) return options.limitReached();
						const budget = engines.budget();
						return budget ? costCapReached(budget.spentUsd + childrenCostUsd, budget.capUsd) : false;
					},
				};
				const result = await engine.run({ toolCallId, agents: params.start }, host);
				return {
					content: [{ type: "text", text: result.text }],
					details: { agents: result.agents },
					// The children's model calls, so the session's cost and the budget count them.
					...(result.usage.totalTokens > 0 || result.usage.cost.total > 0 ? { usage: result.usage } : {}),
				};
			},
		});

		/** Offer the tool exactly while an engine is live. */
		const syncTool = (on: boolean) => {
			const active = fingers.getActiveTools();
			if (on && !active.includes(AGENTS_TOOL)) fingers.setActiveTools([...active, AGENTS_TOOL]);
			else if (!on && active.includes(AGENTS_TOOL)) {
				fingers.setActiveTools(active.filter((name) => name !== AGENTS_TOOL));
			}
		};
		fingers.on("session_start", () => syncTool(engines.engine() !== undefined));
		fingers.on("before_agent_start", () => {
			syncTool(engines.engine() !== undefined);
			return undefined;
		});
	};
}

export default createSubagentsExtension();
