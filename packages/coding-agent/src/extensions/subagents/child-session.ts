/**
 * Child sessions for sub-agents (open core, MIT). A child is an in-process session in its own git worktree that
 * uses the parent's model runtime (the same credentials, never written anywhere), a copy of the parent's effective
 * settings (approval rules, shell, retries) and the parent's approvals: in the terminal app a child's command or
 * outside-the-project write asks in the parent's terminal, one question at a time, naming the child. A child gets
 * the default built-in tools and no extension of its own beyond those approvals: no `agents` tool (no grandchildren),
 * no MCP servers, no memory and no telemetry. Its transcript stays in memory.
 */
import type { ThinkingLevel } from "@veyraco/fingers-agent";
import type { AssistantMessage, Usage } from "@veyraco/fingers-ai";
import { getAgentDir } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ExtensionContext, ExtensionUIContext, InlineExtension } from "../../core/extensions/types.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import { createAgentSession } from "../../core/sdk.ts";
import { type SessionEntry, SessionManager } from "../../core/session-manager.ts";
import { type Settings, SettingsManager } from "../../core/settings-manager.ts";
import {
	emptyUsage,
	MAX_SUBAGENT_SUMMARY_CHARS,
	type SubagentChild,
	type SubagentChildOptions,
	type SubagentChildOutcome,
} from "../../core/subagents/types.ts";
import { combineUsage } from "../../core/usage-totals.ts";
import { type AskForApproval, askInTerminal, createApprovalsExtension } from "../approvals/index.ts";

/** The usage of every model call recorded in a session's entries, as one Usage (costs at list price). */
export function sessionUsage(entries: readonly SessionEntry[]): Usage {
	let usage = emptyUsage();
	for (const entry of entries) {
		if (entry.type === "usage") usage = combineUsage(usage, entry.usage);
		else if (entry.type === "message" && entry.message.role === "assistant") {
			usage = combineUsage(usage, entry.message.usage);
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			usage = combineUsage(usage, entry.message.usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			usage = combineUsage(usage, entry.usage);
		}
	}
	return usage;
}

/** The rules every child gets at the end of its system prompt. */
export function subagentRules(options: { id: string; label: string; cwd: string }): string {
	return [
		`You are sub-agent ${options.id} ("${options.label}") of Fingers, doing one part of a larger task for a parent agent.`,
		`- Work only in ${options.cwd}: a separate git worktree of the repository. When you finish, the files you changed there are merged into the parent's working tree.`,
		"- Do not commit, push, switch branches or change git settings. Do not start servers or other long-running processes.",
		"- Do only your task. Other sub-agents may be changing other files at the same time.",
		"- End with a short summary (a few sentences) of what you changed and anything left to do.",
	].join("\n");
}

export interface ChildSessionDeps {
	/** The parent's model runtime: the child's model calls use the same credentials. */
	modelRuntime: ModelRuntime;
	/** The parent's effective settings. */
	settings: Settings;
	thinkingLevel?: ThinkingLevel;
	/** The parent's mode and UI: a TUI parent asks the person for a child's approvals. */
	mode: ExtensionContext["mode"];
	ui: ExtensionUIContext;
	/** The parent's context, for the approval box. */
	parent: ExtensionContext;
	/** How to ask the person (default: the approval box in the parent's terminal). */
	ask?: AskForApproval;
	/** Default: the agent directory (global AGENTS.md and skills). */
	agentDir?: string;
	/** One approval question at a time across every child of the process. */
	approvalQueue?: ApprovalQueue;
}

/** Runs approval questions one after another, so two children never draw two boxes at once. */
export class ApprovalQueue {
	private tail: Promise<unknown> = Promise.resolve();

	run<T>(task: () => Promise<T>): Promise<T> {
		const next = this.tail.then(task, task);
		this.tail = next.catch(() => undefined);
		return next;
	}
}

const defaultApprovalQueue = new ApprovalQueue();

function cut(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function lastAssistant(session: AgentSession): AssistantMessage | undefined {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const message = session.messages[i];
		if (message.role === "assistant") return message as AssistantMessage;
	}
	return undefined;
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

/** Makes the child session; rejects when its model is unknown. */
export async function createChildSession(
	options: SubagentChildOptions,
	deps: ChildSessionDeps,
): Promise<SubagentChild> {
	const runtime = deps.modelRuntime;
	const modelRef = options.model;
	const model = modelRef ? runtime.getModel(modelRef.provider, modelRef.id) : undefined;
	if (modelRef && !model) throw new Error(`Unknown model ${modelRef.provider}/${modelRef.id}`);
	if (!model) throw new Error("No model to run the sub-agent on");

	const agentDir = deps.agentDir ?? getAgentDir();
	// The worktree is a copy of the parent's project: its project files (`.fingers/SYSTEM.md`, project skills) count
	// only when the parent trusts the project.
	const settingsManager = SettingsManager.inMemory(structuredClone(deps.settings), {
		projectTrusted: deps.parent.isProjectTrusted(),
	});
	settingsManager.applyOverrides({ cacheWarming: "off" });

	const waiting = new Set<(waiting: boolean) => void>();
	const queue = deps.approvalQueue ?? defaultApprovalQueue;
	const ask = deps.ask ?? askInTerminal;
	const childAsk: AskForApproval = (_childCtx, request) =>
		queue.run(async () => {
			for (const listener of waiting) listener(true);
			try {
				return await ask(deps.parent, {
					...request,
					reason: `Sub-agent ${options.id} (${options.label}): ${request.reason}`,
				});
			} finally {
				for (const listener of waiting) listener(false);
			}
		});
	const approvals: InlineExtension = {
		name: "approvals",
		factory: createApprovalsExtension({ ask: childAsk }),
	};
	const rules = subagentRules({ id: options.id, label: options.label, cwd: options.cwd });
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		extensionFactories: [approvals],
		noPromptTemplates: true,
		noThemes: true,
		appendSystemPromptOverride: (base) => [...base, rules],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir,
		modelRuntime: runtime,
		model,
		thinkingLevel: deps.thinkingLevel,
		settingsManager,
		sessionManager: SessionManager.inMemory(options.cwd),
		resourceLoader,
	});
	await session.bindExtensions({ uiContext: deps.ui, mode: deps.mode, onError: () => {} });

	const usageListeners = new Set<(usage: Usage) => void>();
	const usage = () => sessionUsage(session.sessionManager.getEntries());
	const unsubscribe = session.subscribe((event) => {
		if (event.type !== "message_end" || event.message.role !== "assistant") return;
		const current = usage();
		for (const listener of usageListeners) {
			try {
				listener(current);
			} catch {
				// A listener's failure must not stop the child.
			}
		}
	});

	let running = false;
	let aborted = false;
	let disposed = false;
	const child: SubagentChild = {
		id: options.id,
		async run(): Promise<SubagentChildOutcome> {
			if (aborted) return { status: "stopped", summary: "Stopped before it started." };
			running = true;
			try {
				await session.prompt(options.task, { expandPromptTemplates: false, source: "extension" });
				await session.waitForIdle();
			} catch (error) {
				if (aborted) return { status: "stopped", summary: "Stopped." };
				const message = error instanceof Error ? error.message : String(error);
				return { status: "failed", summary: cut(message, MAX_SUBAGENT_SUMMARY_CHARS) };
			} finally {
				running = false;
			}
			const last = lastAssistant(session);
			const text = last ? assistantText(last) : "";
			if (aborted || last?.stopReason === "aborted") {
				return {
					status: "stopped",
					summary: cut(text ? `Stopped. ${text}` : "Stopped.", MAX_SUBAGENT_SUMMARY_CHARS),
				};
			}
			if (!last) return { status: "failed", summary: "The sub-agent gave no answer." };
			if (last.stopReason === "error") {
				return {
					status: "failed",
					summary: cut(`Model error: ${last.errorMessage ?? "unknown error"}`, MAX_SUBAGENT_SUMMARY_CHARS),
				};
			}
			return { status: "done", summary: cut(text || "Done.", MAX_SUBAGENT_SUMMARY_CHARS) };
		},
		steer(text: string): boolean {
			if (!running || aborted || disposed) return false;
			void session.steer(text, undefined, { source: "extension" }).catch(() => undefined);
			return true;
		},
		abort(): void {
			aborted = true;
			void session.abort().catch(() => undefined);
		},
		usage,
		onUsage(listener) {
			usageListeners.add(listener);
			return () => usageListeners.delete(listener);
		},
		onApproval(listener) {
			waiting.add(listener);
			return () => waiting.delete(listener);
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			usageListeners.clear();
			waiting.clear();
			session.dispose();
		},
	};
	return child;
}
