/**
 * The memory provider that is live in this process. The terminal app's ee gate fills it with the provider factory of
 * the Brain feature while that feature is on (signed in, Fingers on for the organization, a tier that includes Brain)
 * and asks again before every use, so memory stops the moment the feature goes off. Managed RPC, print and JSON modes
 * never fill it; managed RPC brings its own relay provider (modes/rpc/managed).
 */
import { projectRepository } from "./project.ts";
import type { MemoryProvider, MemoryProviderContext } from "./types.ts";

export type MemoryProviderFactory = (context: MemoryProviderContext) => MemoryProvider | undefined;

export class MemoryProviders {
	private factory: MemoryProviderFactory | undefined;
	private isOn: () => boolean = () => false;
	private readonly repositories = new Map<string, string | undefined>();
	private readonly listeners = new Set<() => void>();
	private readonly onError: (error: unknown) => void;
	private readonly lookupRepository: (cwd: string) => Promise<string | undefined>;

	constructor(
		options: {
			onError?: (error: unknown) => void;
			lookupRepository?: (cwd: string) => Promise<string | undefined>;
		} = {},
	) {
		this.onError = options.onError ?? (() => {});
		this.lookupRepository = options.lookupRepository ?? ((cwd) => projectRepository(cwd));
	}

	/** Use this factory from now on; `isOn` is asked again before every use. */
	set(factory: MemoryProviderFactory, isOn: () => boolean): void {
		this.factory = factory;
		this.isOn = isOn;
		this.changed();
	}

	/** No provider: memory off. */
	clear(): void {
		this.factory = undefined;
		this.isOn = () => false;
		this.changed();
	}

	/** Called after every set() and clear(). Returns the unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Some factory is set (its feature may be off right now). */
	get hasFactory(): boolean {
		return this.factory !== undefined;
	}

	/** The provider for `cwd` right now, or undefined (none, its feature is off, or the factory failed). */
	async providerFor(cwd: string): Promise<MemoryProvider | undefined> {
		if (!this.factory || !this.isOn()) return undefined;
		let repository: string | undefined;
		if (this.repositories.has(cwd)) {
			repository = this.repositories.get(cwd);
		} else {
			repository = await this.lookupRepository(cwd).catch(() => undefined);
			this.repositories.set(cwd, repository);
		}
		return this.create({ cwd, repository });
	}

	/**
	 * The provider for `cwd` without waiting (the status line): undefined until providerFor() has looked up the
	 * directory's repository once.
	 */
	peek(cwd: string): MemoryProvider | undefined {
		if (!this.factory || !this.isOn() || !this.repositories.has(cwd)) return undefined;
		return this.create({ cwd, repository: this.repositories.get(cwd) });
	}

	private create(context: MemoryProviderContext): MemoryProvider | undefined {
		const factory = this.factory;
		if (!factory || !this.isOn()) return undefined;
		try {
			return factory(context) ?? undefined;
		} catch (error) {
			this.onError(error);
			return undefined;
		}
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

/** This process' memory providers: the terminal app's gate fills it, the built-in `memory` extension uses it. */
export const memoryProviders = new MemoryProviders();
