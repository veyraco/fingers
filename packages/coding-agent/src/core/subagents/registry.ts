/**
 * The sub-agent engine that is live in this process. The terminal app's ee gate fills it with the engine of the
 * sub-agents feature while that feature is on (signed in, Fingers on for the organization, a tier that includes
 * sub-agents) and asks again before every use, so sub-agents stop being offered the moment the feature goes off.
 * Managed RPC, print and JSON modes never fill it.
 *
 * It also carries what the terminal app adds to every `agents` call (the cost budget) and passes the engines'
 * lifecycle events to listeners (the `/agents` panel, F19; managed RPC events, F18b).
 */
import type { SubagentEngine, SubagentEvent } from "./types.ts";

/** The session's cost budget, as the terminal app's budget guard reports it. */
export type SubagentBudgetSource = () => { spentUsd: number; capUsd: number } | undefined;

export class SubagentEngines {
	private current: SubagentEngine | undefined;
	private isOn: () => boolean = () => false;
	private budgetSource: SubagentBudgetSource = () => undefined;
	private readonly changeListeners = new Set<() => void>();
	private readonly eventListeners = new Set<(event: SubagentEvent) => void>();

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
