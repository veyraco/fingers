/**
 * The ee gate: whether an ee feature is on, and the commands the ee module registered for the features that are.
 *
 * A feature is on only when all of these hold, checked in this order (the first that fails is the reason shown):
 * the ee module is there (built with the same contract version), the person is signed in to Veyra, Connect confirmed
 * the organization's facts within the offline grace period and did not refuse them, the organization has the
 * `fingers` app on, Connect's tier is one Fingers knows, and the tier is at least the feature's minimum tier in the
 * ee module's tier matrix.
 */
import { type EntitlementSource, resolveEntitlement } from "./entitlement.ts";
import { EE_COMMANDS } from "./features.ts";
import {
	EE_API_VERSION,
	EE_FEATURE_IDS,
	type EeCommandHandler,
	type EeEntitlement,
	type EeFeatureId,
	type EeFeatureState,
	type EeHost,
	type EeModule,
	isVeyraTier,
	SIGNED_OUT,
	tierIncludes,
} from "./types.ts";

/** Whether `feature` is on for `entitlement`, and if not, why. */
export function eeFeatureState(
	feature: EeFeatureId,
	entitlement: EeEntitlement,
	module: EeModule | undefined,
): EeFeatureState {
	if (!module) return { on: false, reason: "no_ee" };
	if (!entitlement.signedIn) return { on: false, reason: "signed_out" };
	if (entitlement.denied) return { on: false, reason: "denied" };
	if (entitlement.source === "none") return { on: false, reason: "offline" };
	if (!entitlement.fingersEnabled) return { on: false, reason: "fingers_off" };
	if (!isVeyraTier(entitlement.tier)) return { on: false, reason: "unknown_tier" };
	let needs: ReturnType<EeModule["minimumTier"]>;
	try {
		needs = module.minimumTier(feature);
	} catch {
		needs = undefined;
	}
	if (!isVeyraTier(needs)) return { on: false, reason: "tier" };
	if (!tierIncludes(entitlement.tier, needs)) return { on: false, reason: "tier", needs };
	return { on: true };
}

export interface EditionGateOptions {
	/** Finds and imports the ee module; undefined when this build has none (loader.ts by default). */
	loadModule: () => Promise<EeModule | undefined>;
	now?: () => number;
	/** Told when the module failed to activate (it stays loaded, its commands are dropped). */
	onActivateError?: (error: unknown) => void;
}

export class EditionGate {
	private readonly options: EditionGateOptions;
	private modulePromise: Promise<EeModule | undefined> | undefined;
	private module: EeModule | undefined;
	private current: EeEntitlement = SIGNED_OUT;
	private commands = new Map<string, EeCommandHandler>();
	private readonly listeners = new Set<() => void>();

	constructor(options: EditionGateOptions) {
		this.options = options;
	}

	get entitlement(): EeEntitlement {
		return this.current;
	}

	/** The loaded ee module (after `load()`), or undefined: core only. */
	get eeModule(): EeModule | undefined {
		return this.module;
	}

	/** Find and import the ee module once. */
	async load(): Promise<EeModule | undefined> {
		this.modulePromise ??= this.options.loadModule().catch(() => undefined);
		this.module = await this.modulePromise;
		return this.module;
	}

	state(feature: EeFeatureId): EeFeatureState {
		return eeFeatureState(feature, this.current, this.module);
	}

	/** The features that are on, in canvas order. */
	onFeatures(): EeFeatureId[] {
		return EE_FEATURE_IDS.filter((feature) => this.state(feature).on);
	}

	/** "ee on" in the status line: at least one ee feature is on. */
	isOn(): boolean {
		return this.onFeatures().length > 0;
	}

	/** The ee feature behind a built-in slash command, e.g. "agents" -> "subagents". */
	commandFeature(name: string): EeFeatureId | undefined {
		return Object.hasOwn(EE_COMMANDS, name) ? EE_COMMANDS[name] : undefined;
	}

	/** The registered handler for an ee command, only while its feature is on. */
	commandHandler(name: string): EeCommandHandler | undefined {
		const feature = this.commandFeature(name);
		if (!feature || !this.state(feature).on) return undefined;
		return this.commands.get(name);
	}

	/** Use these facts and let the ee module register the commands of what is on now. */
	async setEntitlement(entitlement: EeEntitlement): Promise<void> {
		await this.load();
		this.current = entitlement;
		this.activate();
		for (const listener of this.listeners) listener();
	}

	/** Ask Connect again (falls back to the kept answer while Connect is unreachable). */
	async refresh(
		source: EntitlementSource | undefined,
		options: { signal?: AbortSignal } = {},
	): Promise<EeEntitlement> {
		const entitlement = source
			? await resolveEntitlement(source, { now: this.options.now, signal: options.signal })
			: SIGNED_OUT;
		await this.setEntitlement(entitlement);
		return entitlement;
	}

	/** Called after every entitlement change. Returns the unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private activate(): void {
		this.commands = new Map();
		const module = this.module;
		if (!module) return;
		const commands = new Map<string, EeCommandHandler>();
		const host: EeHost = {
			apiVersion: EE_API_VERSION,
			entitlement: this.current,
			isOn: (feature) => this.state(feature).on,
			registerCommand: (name, handler) => {
				const feature = this.commandFeature(name);
				if (!feature || !this.state(feature).on) return;
				commands.set(name, handler);
			},
		};
		try {
			module.activate(host);
			this.commands = commands;
		} catch (error) {
			this.options.onActivateError?.(error);
		}
	}
}
