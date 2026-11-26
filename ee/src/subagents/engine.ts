// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * The sub-agent engine (F18): runs the children of one `agents` call.
 *
 * - Plan: each child gets an id (`sub_<n>`, unique in the process), its model (the core picks a cheaper one when
 *   routing finds one) and its dependencies (labels of the same call; an unknown label or a cycle refuses the call).
 * - Run: up to `maxParallel` children at once, each in its own git worktree at a snapshot of the parent's working
 *   tree taken when it starts, so a child that waited for others sees their merged changes. A child whose
 *   dependency did not finish with its changes merged is stopped before it starts.
 * - Merge: a finished child's changes are applied to the parent's working tree as a patch, one child at a time; a
 *   patch that does not apply (the same lines changed meanwhile) leaves the worktree in place and says so. A child
 *   that failed or was stopped keeps its worktree when it changed something, for the person to look at.
 * - Isolation: a failing child never fails the call or the other children; the call rejects only for a bad request
 *   or outside a git repository.
 * - Cost: each child's usage is its own session's model calls; the call's usage is their sum. While children run,
 *   their spend counts toward the session's budget: once it is reached, every child is stopped. The budget is asked
 *   before each child starts too, so a call made when the budget is already reached starts no child.
 *
 * - Control (F19, the `/agents` panel): a running child can be paused (held before its next model call) and resumed;
 *   a checkpoint is a commit of its worktree plus the point of its transcript where it waits before a model call;
 *   resuming from a checkpoint puts both back and the child goes on from there. Checkpoints live in this process
 *   (the commits are objects no ref points to). An ended child's kept worktree can be removed.
 *
 * Lifecycle events follow Fingers RPC v1 (`subagent_started` with `running` or `queued`, `subagent_updated` on each
 * status change, `subagent_finished` once).
 */
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type {
	SubagentCheckpoint,
	SubagentChild,
	SubagentEndStatus,
	SubagentEngine,
	SubagentInfo,
	SubagentKind,
	SubagentRunHost,
	SubagentRunRequest,
	SubagentRunResult,
	SubagentSpec,
	SubagentStatus,
	SubagentTranscriptLine,
} from "@veyraco/fingers";
import { nodeGit, type SubagentGit, WORKTREES_DIR } from "./git.ts";

type Usage = SubagentInfo["usage"];

export const DEFAULT_MAX_PARALLEL = 4;
export const MAX_AGENTS_PER_CALL = 8;
const MAX_LABEL_CHARS = 80;
const MAX_TASK_CHARS = 4_000;
const MAX_SUMMARY_CHARS = 4_000;
/** Of each child's summary, what the parent model gets back in the tool result. */
const RESULT_SUMMARY_CHARS = 1_500;
const KINDS: readonly SubagentKind[] = ["code", "search", "review"];
const BUDGET_REACHED = "Stopped: the session's budget is reached.";
/** Most checkpoints kept per child (the oldest goes first). */
export const MAX_CHECKPOINTS_PER_AGENT = 20;
const MAX_ACTIVITY = 3;
const ROLLED_BACK_NOTE = (id: string) =>
	`The person rolled you back to checkpoint ${id}: your files and this conversation are as they were then, and what you did after it is gone. Go on with your task from here.`;

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function addUsage(a: Usage, b: Usage): Usage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total,
		},
	};
}

function cut(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Runs tasks one after another (snapshots and merges of one repository must not interleave). */
class Mutex {
	private tail: Promise<unknown> = Promise.resolve();

	run<T>(task: () => Promise<T>): Promise<T> {
		const next = this.tail.then(task, task);
		this.tail = next.catch(() => undefined);
		return next;
	}
}

interface CheckpointRecord extends SubagentCheckpoint {
	/** The commit of the worktree. */
	commit: string;
	/** The point of the transcript (atRest's position). */
	position: string | null;
}

interface Entry {
	info: SubagentInfo;
	spec: SubagentSpec;
	/** The repository root. */
	root: string;
	/** Absolute path of the worktree. */
	path: string;
	checkpoints: CheckpointRecord[];
	/** The transcript once the child's session is gone. */
	transcript?: SubagentTranscriptLine[];
	paused?: boolean;
	base?: string;
	child?: SubagentChild;
	stopReason?: string;
	ended: boolean;
	/** Ends a child that has not started yet at once (set while its call runs). */
	stopNow?: () => void;
}

function copyInfo(info: SubagentInfo): SubagentInfo {
	return {
		...info,
		dependsOn: [...info.dependsOn],
		usage: { ...info.usage, cost: { ...info.usage.cost } },
		...(info.model ? { model: { ...info.model } } : {}),
		...(info.checkpoints ? { checkpoints: info.checkpoints.map((checkpoint) => ({ ...checkpoint })) } : {}),
		...(info.pendingApproval ? { pendingApproval: { ...info.pendingApproval } } : {}),
		...(info.activity ? { activity: [...info.activity] } : {}),
	};
}

/** Checks the request; returns the specs with their kinds, or throws a message the model can act on. */
export function validateSpecs(specs: readonly SubagentSpec[]): (SubagentSpec & { kind: SubagentKind })[] {
	// `specs as unknown`: Array.isArray on the parameter itself would narrow it to `any[]` and untype every spec below.
	if (!Array.isArray(specs as unknown) || specs.length === 0) throw new Error("agents: start at least one sub-agent.");
	if (specs.length > MAX_AGENTS_PER_CALL) {
		throw new Error(`agents: at most ${MAX_AGENTS_PER_CALL} sub-agents per call (got ${specs.length}).`);
	}
	const labels = new Set<string>();
	const checked = specs.map((spec) => {
		const label = typeof spec?.label === "string" ? spec.label.trim() : "";
		const task = typeof spec?.task === "string" ? spec.task.trim() : "";
		if (!label || label.length > MAX_LABEL_CHARS) {
			throw new Error(`agents: every sub-agent needs a label of 1 to ${MAX_LABEL_CHARS} characters.`);
		}
		if (!task || task.length > MAX_TASK_CHARS) {
			throw new Error(`agents: the task of "${label}" must be 1 to ${MAX_TASK_CHARS} characters.`);
		}
		if (labels.has(label)) throw new Error(`agents: the label "${label}" is used twice; labels must be unique.`);
		labels.add(label);
		const kind = spec.kind ?? "code";
		if (!KINDS.includes(kind)) throw new Error(`agents: "${label}" has an unknown kind "${String(spec.kind)}".`);
		const depends = [...new Set((spec.depends_on ?? []).map((name) => String(name).trim()))];
		return { label, task, kind, depends_on: depends };
	});
	for (const spec of checked) {
		for (const dependency of spec.depends_on) {
			if (dependency === spec.label) throw new Error(`agents: "${spec.label}" depends on itself.`);
			if (!labels.has(dependency)) {
				throw new Error(
					`agents: "${spec.label}" depends on "${dependency}", which is not a sub-agent of this call.`,
				);
			}
		}
	}
	// A cycle would leave its members waiting forever.
	const byLabel = new Map(checked.map((spec) => [spec.label, spec]));
	const state = new Map<string, "visiting" | "done">();
	const visit = (label: string, path: string[]) => {
		if (state.get(label) === "done") return;
		if (state.get(label) === "visiting") {
			throw new Error(`agents: the dependencies form a cycle (${[...path, label].join(" -> ")}).`);
		}
		state.set(label, "visiting");
		for (const dependency of byLabel.get(label)?.depends_on ?? []) visit(dependency, [...path, label]);
		state.set(label, "done");
	};
	for (const spec of checked) visit(spec.label, []);
	return checked;
}

/** The parent's directory relative to the repository root (`""` at the root). */
function relativeCwd(root: string, cwd: string): string {
	let resolved = cwd;
	try {
		resolved = realpathSync.native(cwd);
	} catch {
		// Keep the path as given.
	}
	const rel = relative(root, resolved);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return "";
	return rel;
}

export interface SubagentEngineOptions {
	git?: SubagentGit;
	maxParallel?: number;
	/** Whether checkpoints are on (the `checkpoints` feature); default on. Asked before every checkpoint and roll-back. */
	checkpointsOn?: () => boolean;
}

/** Why an action of the panel cannot be done, in words for the person. */
export class SubagentActionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubagentActionError";
	}
}

export class SubagentEngineImpl implements SubagentEngine {
	private sequence = 0;
	private checkpointSequence = 0;
	private readonly entries = new Map<string, Entry>();
	private checkpointsOn: () => boolean;
	/** Reports a change of a child outside a run's own events (pause, resume, checkpoint), set per run. */
	private readonly reporters = new Map<string, (entry: Entry) => void>();
	private readonly git: SubagentGit;
	private readonly maxParallel: number;
	/** One per repository root. */
	private readonly locks = new Map<string, Mutex>();

	constructor(options: SubagentEngineOptions = {}) {
		this.git = options.git ?? nodeGit;
		this.maxParallel = Math.max(1, Math.floor(options.maxParallel ?? DEFAULT_MAX_PARALLEL));
		this.checkpointsOn = options.checkpointsOn ?? (() => true);
	}

	/** Whether checkpoints are on, asked before every checkpoint and roll-back (the ee module sets the feature's gate). */
	setCheckpointsGate(isOn: () => boolean): void {
		this.checkpointsOn = isOn;
	}

	list(): readonly SubagentInfo[] {
		return [...this.entries.values()].map((entry) => copyInfo(entry.info));
	}

	steer(id: string, text: string): boolean {
		const entry = this.entries.get(id);
		if (!entry?.child || entry.ended || !text.trim()) return false;
		return entry.child.steer(text);
	}

	stop(id: string): boolean {
		const entry = this.entries.get(id);
		if (!entry || entry.ended) return false;
		entry.stopReason ??= "Stopped by the person.";
		entry.child?.abort();
		entry.stopNow?.();
		return true;
	}

	pause(id: string): boolean {
		const entry = this.entries.get(id);
		if (!entry?.child || entry.ended || entry.paused) return false;
		if (!entry.child.pause()) return false;
		entry.paused = true;
		this.reporters.get(id)?.(entry);
		return true;
	}

	async resume(id: string, checkpoint?: string): Promise<void> {
		const entry = this.entries.get(id);
		if (!entry) throw new SubagentActionError(`There is no sub-agent ${id}.`);
		if (entry.ended || !entry.child) throw new SubagentActionError(`${id} is not running, so it cannot be resumed.`);
		if (!entry.paused) throw new SubagentActionError(`${id} is not paused.`);
		if (checkpoint === undefined) {
			if (!entry.child.resume()) throw new SubagentActionError(`${id} is not paused.`);
			entry.paused = false;
			this.reporters.get(id)?.(entry);
			return;
		}
		if (!this.checkpointsOn()) throw new SubagentActionError("Checkpoints are not on for your organization's tier.");
		const record = entry.checkpoints.find((candidate) => candidate.id === checkpoint);
		if (!record) throw new SubagentActionError(`${id} has no checkpoint ${checkpoint}.`);
		const child = entry.child;
		try {
			await child.rollBack(record.position, ROLLED_BACK_NOTE(record.id), () =>
				this.lockOf(entry.root).run(() => this.git.restore(entry.path, record.commit)),
			);
		} catch (error) {
			throw new SubagentActionError(
				`Could not resume ${id} from ${record.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		// What came after the checkpoint is gone.
		entry.checkpoints = entry.checkpoints.filter((candidate) => candidate.at <= record.at);
		entry.info.checkpoints = entry.checkpoints.map(({ id: cp, at, filesChanged }) => ({ id: cp, at, filesChanged }));
		entry.paused = false;
		this.reporters.get(id)?.(entry);
	}

	async checkpoint(id: string): Promise<SubagentCheckpoint> {
		const entry = this.entries.get(id);
		if (!entry) throw new SubagentActionError(`There is no sub-agent ${id}.`);
		if (!this.checkpointsOn()) throw new SubagentActionError("Checkpoints are not on for your organization's tier.");
		if (entry.ended || !entry.child || !entry.base) {
			throw new SubagentActionError(`${id} is not running, so there is nothing to keep a checkpoint of.`);
		}
		const base = entry.base;
		const record = await entry.child
			.atRest(async (position) => {
				const checkpointId = `cp-${++this.checkpointSequence}`;
				return this.lockOf(entry.root).run(async () => {
					const commit = await this.git.snapshot(
						entry.path,
						`Fingers checkpoint ${checkpointId} of sub-agent ${entry.info.id}`,
					);
					const { files } = await this.git.changes(entry.path, base);
					const created: CheckpointRecord = {
						id: checkpointId,
						at: Date.now(),
						filesChanged: files.length,
						commit,
						position,
					};
					return created;
				});
			})
			.catch((error: unknown) => {
				throw new SubagentActionError(
					`Could not keep a checkpoint of ${id}: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		entry.checkpoints.push(record);
		if (entry.checkpoints.length > MAX_CHECKPOINTS_PER_AGENT) entry.checkpoints.shift();
		entry.info.checkpoints = entry.checkpoints.map(({ id: cp, at, filesChanged }) => ({ id: cp, at, filesChanged }));
		this.reporters.get(id)?.(entry);
		return { id: record.id, at: record.at, filesChanged: record.filesChanged };
	}

	transcript(id: string): SubagentTranscriptLine[] | undefined {
		const entry = this.entries.get(id);
		if (!entry) return undefined;
		if (entry.transcript) return entry.transcript;
		if (!entry.child) return [];
		try {
			return entry.child.transcript();
		} catch {
			return [];
		}
	}

	async removeWorktree(id: string): Promise<void> {
		const entry = this.entries.get(id);
		if (!entry) throw new SubagentActionError(`There is no sub-agent ${id}.`);
		if (!entry.ended) throw new SubagentActionError(`${id} is still going; stop it first.`);
		if (!entry.info.keptWorktree) throw new SubagentActionError(`${id} kept no worktree.`);
		await this.lockOf(entry.root).run(() => this.git.removeWorktree(entry.root, entry.path));
		delete entry.info.keptWorktree;
		entry.checkpoints = [];
		delete entry.info.checkpoints;
	}

	private lockOf(root: string): Mutex {
		let lock = this.locks.get(root);
		if (!lock) {
			lock = new Mutex();
			this.locks.set(root, lock);
		}
		return lock;
	}

	async run(request: SubagentRunRequest, host: SubagentRunHost): Promise<SubagentRunResult> {
		const specs = validateSpecs(request.agents);
		const root = await this.git.root(host.cwd);
		await this.git.prepare(root);
		const rel = relativeCwd(root, host.cwd);
		const repoLock = this.lockOf(root);

		const byLabel = new Map<string, Entry>();
		const entries: Entry[] = specs.map((spec) => {
			// A worktree kept by an earlier process (its changes did not merge) keeps its id.
			let id = `sub_${++this.sequence}`;
			while (existsSync(join(root, WORKTREES_DIR, id))) id = `sub_${++this.sequence}`;
			const worktree = join(WORKTREES_DIR, id).split(sep).join("/");
			const info: SubagentInfo = {
				id,
				parentId: "main",
				label: spec.label,
				task: spec.task,
				kind: spec.kind,
				worktree,
				dependsOn: [],
				status: "queued",
				usage: emptyUsage(),
			};
			const model = host.pickModel(spec.kind);
			if (model) info.model = model;
			const entry: Entry = { info, spec, root, path: join(root, WORKTREES_DIR, id), checkpoints: [], ended: false };
			byLabel.set(spec.label, entry);
			this.entries.set(id, entry);
			return entry;
		});
		for (const entry of entries) {
			entry.info.dependsOn = (entry.spec.depends_on ?? []).map((label) => byLabel.get(label)!.info.id);
		}

		const report = (type: "subagent_started" | "subagent_updated" | "subagent_finished", entry: Entry) => {
			try {
				host.report({ type, agent: copyInfo(entry.info) });
			} catch {
				// A listener's failure must not stop the children.
			}
		};
		const setStatus = (entry: Entry, status: SubagentStatus) => {
			if (entry.ended || entry.info.status === status) return;
			entry.info.status = status;
			report("subagent_updated", entry);
		};
		const finish = (entry: Entry, status: SubagentEndStatus, summary: string) => {
			if (entry.ended) return;
			entry.ended = true;
			entry.paused = false;
			delete entry.info.pendingApproval;
			this.reporters.delete(entry.info.id);
			entry.info.status = status;
			entry.info.summary = cut(summary, MAX_SUMMARY_CHARS);
			entry.info.endedAt = Date.now();
			report("subagent_finished", entry);
		};

		// Spend of this call's children, for the session's budget.
		const childrenCost = () => entries.reduce((sum, entry) => sum + entry.info.usage.cost.total, 0);
		let stopAllReason: string | undefined;
		// A budget that is already reached starts no child: each one ends "stopped" after its start event.
		if (host.budgetReached(0)) {
			stopAllReason = BUDGET_REACHED;
			for (const entry of entries) entry.stopReason = BUDGET_REACHED;
		}

		// The status a running child shows: paused wins over waiting for an approval.
		const liveStatus = (entry: Entry): SubagentStatus =>
			entry.paused ? "paused" : entry.info.pendingApproval ? "waiting_approval" : "running";
		for (const entry of entries) {
			this.reporters.set(entry.info.id, (changed) => {
				if (changed.ended) return;
				const status = changed.child ? liveStatus(changed) : changed.info.status;
				if (changed.info.status !== status) setStatus(changed, status);
				else report("subagent_updated", changed);
			});
			entry.stopNow = () => {
				if (entry.info.startedAt === undefined)
					finish(entry, "stopped", entry.stopReason ?? "Stopped before it started.");
			};
		}

		const stopAll = (reason: string) => {
			stopAllReason ??= reason;
			for (const entry of entries) {
				if (entry.ended) continue;
				entry.stopReason ??= reason;
				entry.child?.abort();
				entry.stopNow?.();
			}
		};
		const onAbort = () => stopAll("Stopped: the parent's run was stopped.");
		if (host.signal.aborted) onAbort();
		else host.signal.addEventListener("abort", onAbort, { once: true });

		const dropWorktree = async (entry: Entry, keepWhenChanged: boolean) => {
			if (!entry.base) return;
			try {
				if (keepWhenChanged) {
					const { files } = await this.git.changes(entry.path, entry.base);
					if (files.length > 0) {
						entry.info.keptWorktree = entry.info.worktree;
						return;
					}
				}
				await this.git.removeWorktree(root, entry.path);
			} catch {
				entry.info.keptWorktree = entry.info.worktree;
			}
		};

		const runChild = async (entry: Entry): Promise<void> => {
			let child: SubagentChild | undefined;
			const unsubscribe: (() => void)[] = [];
			try {
				await repoLock.run(async () => {
					const base = await this.git.snapshot(root);
					await this.git.addWorktree(root, entry.path, base);
					entry.base = base;
				});
				if (entry.stopReason) {
					finish(entry, "stopped", entry.stopReason);
					await dropWorktree(entry, false);
					return;
				}
				child = await host.startChild({
					id: entry.info.id,
					label: entry.info.label,
					task: entry.info.task,
					cwd: rel ? join(entry.path, rel) : entry.path,
					...(entry.info.model ? { model: entry.info.model } : {}),
				});
				entry.child = child;
				unsubscribe.push(
					child.onUsage((usage) => {
						entry.info.usage = usage;
						if (!stopAllReason && host.budgetReached(childrenCost())) {
							stopAll(BUDGET_REACHED);
						}
					}),
					child.onApproval((waiting, question) => {
						if (entry.ended) return;
						if (waiting) entry.info.pendingApproval = question ?? { command: "", reason: "" };
						else delete entry.info.pendingApproval;
						const status = liveStatus(entry);
						if (entry.info.status !== status) setStatus(entry, status);
						else report("subagent_updated", entry);
					}),
					child.onActivity((line) => {
						if (entry.ended) return;
						entry.info.activity = [...(entry.info.activity ?? []), line].slice(-MAX_ACTIVITY);
						report("subagent_updated", entry);
					}),
				);
				// Stopped while its session was being made.
				if (entry.stopReason) child.abort();
				const outcome = await child.run();
				entry.info.usage = child.usage();
				const status: SubagentEndStatus =
					entry.stopReason && outcome.status !== "done" ? "stopped" : outcome.status;
				if (status !== "done") {
					const reason = status === "stopped" && entry.stopReason ? entry.stopReason : outcome.summary;
					await dropWorktree(entry, true);
					const kept = entry.info.keptWorktree ? ` Its changes are kept in ${entry.info.keptWorktree}.` : "";
					finish(entry, status, `${reason}${kept}`);
					return;
				}
				await repoLock.run(async () => {
					const { files, patch } = await this.git.changes(entry.path, entry.base!);
					entry.info.filesChanged = files.length;
					if (files.length === 0) {
						entry.info.merged = true;
						return;
					}
					try {
						await this.git.apply(root, patch);
						entry.info.merged = true;
					} catch (error) {
						entry.info.merged = false;
						entry.info.keptWorktree = entry.info.worktree;
						const why = error instanceof Error ? error.message : String(error);
						outcome.summary = `${outcome.summary}\nNot merged: its changes do not apply to the working tree (${cut(why, 300)}). They are kept in ${entry.info.worktree}.`;
					}
				});
				if (entry.info.merged) await dropWorktree(entry, false);
				finish(entry, "done", outcome.summary);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await dropWorktree(entry, true);
				if (entry.stopReason) finish(entry, "stopped", entry.stopReason);
				else finish(entry, "failed", `Could not run: ${message}`);
			} finally {
				for (const stop of unsubscribe) stop();
				if (child) {
					entry.info.usage = child.usage();
					try {
						entry.transcript = child.transcript();
					} catch {
						entry.transcript = [];
					}
					child.dispose();
				}
			}
		};

		// Plan the start: what runs now, what waits (for dependencies or for a free slot).
		let slots = this.maxParallel;
		const startsNow = new Set<Entry>();
		for (const entry of entries) {
			if (entry.info.dependsOn.length === 0 && slots > 0 && !entry.stopReason) {
				startsNow.add(entry);
				slots--;
			}
		}
		for (const entry of entries) {
			entry.info.status = startsNow.has(entry) ? "running" : "queued";
			report("subagent_started", entry);
		}

		const running = new Map<Entry, Promise<void>>();
		const start = (entry: Entry) => {
			entry.info.startedAt = Date.now();
			setStatus(entry, "running");
			running.set(
				entry,
				runChild(entry).finally(() => running.delete(entry)),
			);
		};
		try {
			for (;;) {
				for (const entry of entries) {
					if (entry.ended || running.has(entry) || entry.info.startedAt !== undefined) continue;
					if (entry.stopReason) {
						finish(
							entry,
							"stopped",
							entry.stopReason === stopAllReason ? entry.stopReason : "Stopped before it started.",
						);
						continue;
					}
					const dependencies = entry.info.dependsOn.map((id) => this.entries.get(id)!);
					const blocked = dependencies.find(
						(dependency) => dependency.ended && !(dependency.info.status === "done" && dependency.info.merged),
					);
					if (blocked) {
						const why =
							blocked.info.status === "done" ? "its changes were not merged" : `it ${blocked.info.status}`;
						finish(
							entry,
							"stopped",
							`Not started: ${blocked.info.id} (${blocked.info.label}) did not finish (${why}).`,
						);
						continue;
					}
					if (dependencies.some((dependency) => !dependency.ended)) continue;
					if (running.size >= this.maxParallel) continue;
					// The budget is asked again before every start: what the children spent so far counts.
					if (host.budgetReached(childrenCost())) {
						stopAll(BUDGET_REACHED);
						continue;
					}
					start(entry);
				}
				if (running.size === 0) break;
				await Promise.race(running.values());
			}
		} finally {
			host.signal.removeEventListener("abort", onAbort);
			for (const entry of entries) entry.stopNow = undefined;
		}

		const agents = entries.map((entry) => copyInfo(entry.info));
		const usage = agents.reduce((sum, agent) => addUsage(sum, agent.usage), emptyUsage());
		return { agents, text: resultText(agents), usage };
	}
}

/** For the parent model: one paragraph per child. */
export function resultText(agents: readonly SubagentInfo[]): string {
	return agents
		.map((agent) => {
			let state: string = agent.status;
			if (agent.status === "done") {
				const files = agent.filesChanged ?? 0;
				const changed = files === 1 ? "1 file" : `${files} files`;
				state = agent.merged ? `done, merged (${changed} changed)` : `done, NOT merged (${changed} changed)`;
			}
			const model = agent.model ? ` on ${agent.model.id}` : "";
			const summary = agent.summary ? `\n${cut(agent.summary, RESULT_SUMMARY_CHARS)}` : "";
			return `${agent.id} ${agent.label}${model}: ${state}.${summary}`;
		})
		.join("\n\n");
}
