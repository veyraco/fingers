/**
 * The sub-agent engine that is live in this process. The terminal app's ee gate fills it with the engine of the
 * sub-agents feature while that feature is on (signed in, Fingers on for the organization, a tier that includes
 * sub-agents) and asks again before every use, so sub-agents stop being offered the moment the feature goes off.
 * Print and JSON modes never fill it; managed RPC (F18b) keeps an instance of its own per run, filled when the host
 * turns sub-agents on with `configure.subagents`.
 *
 * It also carries what the terminal app adds to every `agents` call (the cost budget) and passes the engines'
 * lifecycle events to listeners (the `/agents` panel, F19; managed RPC events, F18b), and the approval desk that
 * holds children's questions while the panel is open.
 */
import type { SubagentEngine, SubagentEvent } from "./types.ts";

/**
 * Where a child's approval question waits before its approval box opens. Without a holder the box opens at once (one
 * box at a time, in the child session's queue). While the `/agents` panel is open it holds every question: the
 * panel shows the child as waiting for approval and opens its box when the person presses `a`; closing the panel lets
 * every held question through.
 */
export class SubagentApprovalDesk {
	private holders = 0;
	private readonly held = new Map<string, Array<() => void>>();
	private readonly listeners = new Set<() => void>();

	/**
	 * Resolves when the question of child `id` may be asked now, or when `signal` aborts (the child stopped or was
	 * rolled back): the question then leaves the desk.
	 */
	turn(id: string, signal?: AbortSignal): Promise<void> {
		if (this.holders === 0 || signal?.aborted) return Promise.resolve();
		return new Promise((resolve) => {
			const waiting = this.held.get(id) ?? [];
			const entry = () => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			};
			const onAbort = () => {
				const list = this.held.get(id);
				const index = list?.indexOf(entry) ?? -1;
				if (index === -1) return;
				list!.splice(index, 1);
				if (list!.length === 0) this.held.delete(id);
				resolve();
				this.changed();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			waiting.push(entry);
			this.held.set(id, waiting);
			this.changed();
		});
	}

	/** Holds questions until the returned function is called (the panel opens and closes). */
	hold(): () => void {
		this.holders++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.holders--;
			if (this.holders === 0) {
				const all = [...this.held.values()].flat();
				this.held.clear();
				for (const resolve of all) resolve();
				this.changed();
			}
		};
	}

	/** Lets the oldest held question of child `id` through. False when it has none held. */
	release(id: string): boolean {
		const waiting = this.held.get(id);
		const next = waiting?.shift();
		if (!next) return false;
		if (waiting!.length === 0) this.held.delete(id);
		next();
		this.changed();
		return true;
	}

	/** Whether child `id` has a question held. */
	isHeld(id: string): boolean {
		return (this.held.get(id)?.length ?? 0) > 0;
	}

	/** Called when a question is held or let through. Returns the unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// A listener's failure must not stop the others.
			}
		}
	}
}

/** The session's cost budget, as the terminal app's budget guard reports it. */
export type SubagentBudgetSource = () => { spentUsd: number; capUsd: number } | undefined;

export class SubagentEngines {
	private current: SubagentEngine | undefined;
	private isOn: () => boolean = () => false;
	private budgetSource: SubagentBudgetSource = () => undefined;
	private readonly changeListeners = new Set<() => void>();
	private readonly eventListeners = new Set<(event: SubagentEvent) => void>();
	/** Children's approval questions wait here while the `/agents` panel is open. */
	readonly approvals = new SubagentApprovalDesk();

	/** Use this engine from now on; `isOn` is asked again before every use. */
	set(engine: SubagentEngine, isOn: () => boolean): void {
		this.current = engine;
		this.isOn = isOn;
		this.changed();
	}

	/** No engine: sub-agents off. */
	clear(): void {
		this.current = undefined;
		this.isOn = () => false;
		this.changed();
	}

	/** The engine right now, or undefined (none, or its feature is off). */
	engine(): SubagentEngine | undefined {
		if (!this.current) return undefined;
		try {
			return this.isOn() ? this.current : undefined;
		} catch {
			return undefined;
		}
	}

	/** Called after every set() and clear(). Returns the unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	setBudget(source: SubagentBudgetSource): () => void {
		this.budgetSource = source;
		return () => {
			if (this.budgetSource === source) this.budgetSource = () => undefined;
		};
	}

	budget(): { spentUsd: number; capUsd: number } | undefined {
		try {
			return this.budgetSource();
		} catch {
			return undefined;
		}
	}

	/** Lifecycle events of every sub-agent of this process. Returns the unsubscribe function. */
	onEvent(listener: (event: SubagentEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	emit(event: SubagentEvent): void {
		for (const listener of this.eventListeners) {
			try {
				listener(event);
			} catch {
				// A listener's failure must not stop the others or the engine.
			}
		}
	}

	private changed(): void {
		for (const listener of this.changeListeners) {
			try {
				listener();
			} catch {
				// A listener's failure must not stop the others.
			}
		}
	}
}

/** This process' sub-agent engine: the terminal app's gate fills it, the built-in `subagents` extension uses it. */
export const subagentEngines = new SubagentEngines();
