/**
 * Child sessions for sub-agents (open core, MIT). A child is an in-process session in its own git worktree that
 * uses the parent's model runtime (the same credentials, never written anywhere), a copy of the parent's effective
 * settings (approval rules, shell, retries) and the parent's approvals: in the terminal app a child's command or
 * outside-the-project write asks in the parent's terminal, one question at a time, naming the child. A child gets
 * the default built-in tools and no extension of its own beyond those approvals: no `agents` tool (no grandchildren),
 * no MCP servers, no memory and no telemetry. Its transcript stays in memory.
 *
 * Managed RPC gives a child its own gate instead of the terminal approvals (ChildSessionHooks): the host's path
 * policy and approvals, the run's tools and no skills, and it watches the child's session to forward its records.
 *
 * The `/agents` panel controls a child through it: while the panel is open, a child's approval question waits
 * on the registry's approval desk until the person opens it there; pause holds the child before its next model call
 * (a step that runs finishes first; nothing of its transcript or files changes); atRest runs a task at such a point,
 * where every step has its result (a checkpoint is taken there); rollBack takes a held child's transcript back to such
 * a point and lets it go on with a note.
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
import { SubagentApprovalDesk } from "../../core/subagents/registry.ts";
import {
	emptyUsage,
	MAX_SUBAGENT_SUMMARY_CHARS,
	type SubagentApprovalRequest,
	type SubagentChild,
	type SubagentChildOptions,
	type SubagentChildOutcome,
	type SubagentTranscriptLine,
} from "../../core/subagents/types.ts";
import { combineUsage } from "../../core/usage-totals.ts";
import { type AskForApproval, askInTerminal, createApprovalsExtension } from "../approvals/index.ts";

/** The usage of every model call recorded in a session's entries, as one Usage (costs at list price). */
function sessionUsage(entries: readonly SessionEntry[]): Usage {
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

/** The child a hook is called for. */
export interface ChildIdentity {
	id: string;
	label: string;
	/** Its working directory (inside its worktree). */
	cwd: string;
}

/** What a child's own gate gets from it (ChildSessionHooks.extensions). */
export interface ChildGateContext extends ChildIdentity {
	/** Tell the engine the child waits for an approval (with the question) or no longer does. */
	waiting(waiting: boolean, request?: SubagentApprovalRequest): void;
	/** Aborted when the child stops or is rolled back: a question it still waits on is then dropped. */
	signal(): AbortSignal;
}

/**
 * How a host other than the terminal app (managed RPC) shapes a child. Without hooks a child gets the default built-in
 * tools, skills, and the parent's approvals asked in the parent's terminal.
 */
export interface ChildSessionHooks {
	/** The tools the child may use (default: the default built-in tools). */
	tools?: readonly string[];
	/** No skills (the managed policy). */
	noSkills?: boolean;
	/** Extensions in place of the terminal approvals: they gate the child's tool calls themselves. */
	extensions?(child: ChildGateContext): InlineExtension[];
	/**
	 * Called once the child's session exists, before the child's own listeners, so the host sees each of its events
	 * first. Returns what to call when the child is disposed.
	 */
	attach?(child: ChildIdentity, session: AgentSession): (() => void) | undefined;
}

interface ChildSessionDeps {
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
	/** Where a question waits while the `/agents` panel is open (default: asked at once). */
	approvalDesk?: SubagentApprovalDesk;
	/** A host's own gate, tools and watcher for the child (managed RPC). */
	hooks?: ChildSessionHooks;
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

/** One line without terminal escapes or line breaks. */
function flat(text: string, max: number): string {
	return cut(
		text
			.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
			.replace(/\s+/g, " ")
			.trim(),
		max,
	);
}

/** "edit src/a.ts", "bash pnpm test": a tool call in a few words. */
export function toolStepText(toolName: string, args: unknown): string {
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const pick = (...keys: string[]) => {
		for (const key of keys) {
			const value = record[key];
			if (typeof value === "string" && value.trim()) return value;
		}
		return undefined;
	};
	const what = pick("command", "path", "file_path", "pattern", "url", "query");
	return flat(what ? `${toolName} ${what}` : toolName, 160);
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** The current branch of a session as transcript lines (tool results and long texts cut). */
function transcriptLines(session: AgentSession, task: string): SubagentTranscriptLine[] {
	const lines: SubagentTranscriptLine[] = [];
	for (const message of session.messages) {
		if (message.role === "user") {
			const text = messageText(message.content);
			lines.push({ kind: lines.length === 0 && text === task ? "task" : "user", text: cut(text, 2_000) });
		} else if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			const text = assistantText(assistant);
			if (text) lines.push({ kind: "assistant", text: cut(text, 4_000) });
			for (const block of assistant.content) {
				if (block.type === "toolCall")
					lines.push({ kind: "tool", text: toolStepText(block.name, block.arguments) });
			}
			if (assistant.stopReason === "error" && assistant.errorMessage) {
				lines.push({ kind: "error", text: cut(assistant.errorMessage, 500) });
			}
		} else if (message.role === "toolResult") {
			lines.push({ kind: "tool_result", text: flat(messageText(message.content), 300) });
		}
	}
	return lines;
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

	const waiting = new Set<(waiting: boolean, request?: SubagentApprovalRequest) => void>();
	const queue = deps.approvalQueue ?? defaultApprovalQueue;
	const desk = deps.approvalDesk ?? new SubagentApprovalDesk();
	const ask = deps.ask ?? askInTerminal;
	// The child waits for the person from the moment it asks: while the panel holds the question, and while another
	// child's box is open (one box at a time).
	// Aborted when the child stops or is rolled back: a question still waiting in the panel is then dropped (denied).
	let questions = new AbortController();
	const childAsk: AskForApproval = async (_childCtx, request) => {
		const question: SubagentApprovalRequest = { command: request.command, reason: request.reason };
		const signal = questions.signal;
		for (const listener of waiting) listener(true, question);
		try {
			await desk.turn(options.id, signal);
			if (signal.aborted) return { decision: "deny" };
			return await queue.run(() =>
				ask(deps.parent, {
					...request,
					reason: `Sub-agent ${options.id} (${options.label}): ${request.reason}`,
				}),
			);
		} finally {
			for (const listener of waiting) listener(false);
		}
	};
	const identity: ChildIdentity = { id: options.id, label: options.label, cwd: options.cwd };
	const hooks = deps.hooks;
	const gate: InlineExtension[] = hooks?.extensions
		? hooks.extensions({
				...identity,
				waiting: (on, request) => {
					for (const listener of waiting) listener(on, request);
				},
				signal: () => questions.signal,
			})
		: [{ name: "approvals", factory: createApprovalsExtension({ ask: childAsk }) }];

	// Pause, checkpoints and roll-back: every model call of the child passes this gate first (its `context` event),
	// at a point where each step it started has its result.
	let session!: AgentSession;
	let paused = false;
	let held: (() => void) | undefined;
	const restTasks: Array<{ run: (position: string | null) => Promise<void>; fail: (error: Error) => void }> = [];
	let rollBackTo:
		| {
				position: string | null;
				note: string;
				prepare: () => Promise<void>;
				done: () => void;
				fail: (error: Error) => void;
		  }
		| undefined;
	const atGate = async () => {
		for (;;) {
			while (restTasks.length > 0) await restTasks.shift()!.run(session.sessionManager.getLeafId());
			if (!paused || aborted || rollBackTo) return;
			await new Promise<void>((resolve) => {
				held = resolve;
			});
			held = undefined;
		}
	};
	const release = () => {
		const resolve = held;
		held = undefined;
		resolve?.();
	};
	const control: InlineExtension = {
		name: "subagent-control",
		factory: (fingers) => {
			fingers.on("context", async () => {
				await atGate();
				return undefined;
			});
		},
	};
	const rules = subagentRules({ id: options.id, label: options.label, cwd: options.cwd });
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		extensionFactories: [...gate, control],
		noSkills: hooks?.noSkills === true,
		noPromptTemplates: true,
		noThemes: true,
		appendSystemPromptOverride: (base) => [...base, rules],
	});
	await resourceLoader.reload();
	({ session } = await createAgentSession({
		cwd: options.cwd,
		agentDir,
		modelRuntime: runtime,
		model,
		thinkingLevel: deps.thinkingLevel,
		settingsManager,
		sessionManager: SessionManager.inMemory(options.cwd),
		resourceLoader,
		...(hooks?.tools ? { tools: [...hooks.tools] } : {}),
	}));
	await session.bindExtensions({ uiContext: deps.ui, mode: deps.mode, onError: () => {} });
	// The host watches first: a model call's records and limits are handled before the engine hears of its usage.
	let detach: (() => void) | undefined;
	try {
		detach = hooks?.attach?.(identity, session);
	} catch (error) {
		session.dispose();
		throw error;
	}

	const usageListeners = new Set<(usage: Usage) => void>();
	const activityListeners = new Set<(line: string) => void>();
	const usage = () => sessionUsage(session.sessionManager.getEntries());
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			const line = toolStepText(event.toolName, event.args);
			for (const listener of activityListeners) {
				try {
					listener(line);
				} catch {
					// A listener's failure must not stop the child.
				}
			}
			return;
		}
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
	let ended = false;
	const endRest = () => {
		ended = true;
		const error = new Error(`${options.id} ended before its next model call.`);
		for (const task of restTasks.splice(0)) task.fail(error);
		const pending = rollBackTo;
		rollBackTo = undefined;
		pending?.fail(error);
	};
	/** After a roll-back: the transcript back at the checkpoint, the files put back, and the note to go on with. */
	const applyRollBack = async (target: NonNullable<typeof rollBackTo>): Promise<string> => {
		let prompt = target.note;
		if (target.position === null) {
			session.sessionManager.resetLeaf();
			session.refreshContext();
			prompt = `${options.task}\n\n${target.note}`;
		} else {
			const { editorText } = await session.navigateTree(target.position);
			// The checkpoint was before its first model call: the task itself is sent again.
			if (editorText !== undefined) prompt = `${editorText}\n\n${target.note}`;
		}
		await target.prepare();
		return prompt;
	};
	const child: SubagentChild = {
		id: options.id,
		async run(): Promise<SubagentChildOutcome> {
			if (aborted) return { status: "stopped", summary: "Stopped before it started." };
			running = true;
			let prompt = options.task;
			try {
				for (;;) {
					try {
						await session.prompt(prompt, { expandPromptTemplates: false, source: "extension" });
						await session.waitForIdle();
					} catch (error) {
						if (!rollBackTo) throw error;
					}
					const target = rollBackTo;
					if (!target || aborted) break;
					rollBackTo = undefined;
					try {
						prompt = await applyRollBack(target);
					} catch (error) {
						target.fail(error instanceof Error ? error : new Error(String(error)));
						throw error;
					}
					paused = false;
					target.done();
				}
			} catch (error) {
				if (aborted) return { status: "stopped", summary: "Stopped." };
				const message = error instanceof Error ? error.message : String(error);
				return { status: "failed", summary: cut(message, MAX_SUBAGENT_SUMMARY_CHARS) };
			} finally {
				running = false;
				endRest();
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
			questions.abort();
			void session.abort().catch(() => undefined);
			release();
		},
		pause(): boolean {
			if (!running || aborted || disposed || paused) return false;
			paused = true;
			return true;
		},
		resume(): boolean {
			if (!paused || aborted || disposed || rollBackTo) return false;
			paused = false;
			release();
			return true;
		},
		atRest<T>(task: (position: string | null) => Promise<T>): Promise<T> {
			if (ended || aborted || disposed || rollBackTo)
				return Promise.reject(new Error(`${options.id} is not running.`));
			return new Promise<T>((resolve, reject) => {
				const entry = {
					run: async (position: string | null) => {
						try {
							resolve(await task(position));
						} catch (error) {
							reject(error);
						}
					},
					fail: reject,
				};
				if (held) {
					// Held before a model call: run it now, the child stays held.
					void entry.run(session.sessionManager.getLeafId());
				} else restTasks.push(entry);
			});
		},
		rollBack(position: string | null, note: string, prepare: () => Promise<void>): Promise<void> {
			if (!paused || !running || ended || aborted || disposed || rollBackTo) {
				return Promise.reject(new Error(`${options.id} is not paused.`));
			}
			return new Promise<void>((resolve, reject) => {
				rollBackTo = { position, note, prepare, done: resolve, fail: reject };
				// What it is doing now (the model call it waits for, or a step that still runs) is dropped; run() then
				// takes the transcript back and goes on. A question it still waits on in the panel is dropped too.
				questions.abort();
				questions = new AbortController();
				void session.abort().catch(() => undefined);
				release();
			});
		},
		transcript(): SubagentTranscriptLine[] {
			return transcriptLines(session, options.task);
		},
		onActivity(listener) {
			activityListeners.add(listener);
			return () => activityListeners.delete(listener);
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
			try {
				detach?.();
			} catch {
				// The host's cleanup must not stop the child's.
			}
			usageListeners.clear();
			activityListeners.clear();
			waiting.clear();
			release();
			session.dispose();
		},
	};
	return child;
}
