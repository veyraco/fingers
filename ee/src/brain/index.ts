// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * Brain memory in the terminal app (F20): registers the Brain provider with the core while the `brain` feature is on
 * (signed in, Fingers on for the organization, a tier that includes Brain) and handles `/memory`.
 *
 * The core's memory extension does the rest: the task's memory at its start, the `memory_recall` and
 * `memory_remember` tools, and a learning event when a run ends. Managed RPC (Hands) never gets here: there Fingers
 * holds no Veyra token and relays memory to the host instead.
 */
import type { EeCommandContext, EeHost, EeVeyraApi, MemoryProvider, MemoryProviderContext } from "@veyraco/fingers";
import { BrainMemoryProvider } from "./provider.ts";

export { BrainMemoryProvider, BrainUnavailableError, repositorySpace } from "./provider.ts";

const USAGE = "Usage: /memory, /memory recall <query>, /memory remember <text>, /memory off, /memory on";

function shortName(repository: string): string {
	return repository.slice(repository.lastIndexOf("/") + 1);
}

/** One line of text, without terminal escapes, for the status area. */
function oneLine(text: string, max = 300): string {
	const flat = text
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export class BrainMemory {
	private api: EeVeyraApi | undefined;
	/** Repositories whose memory the person turned off with /memory off, for this process. */
	private readonly paused = new Set<string>();
	private readonly providers = new Map<string, BrainMemoryProvider>();
	private readonly fetchImpl?: typeof fetch;

	constructor(options: { fetch?: typeof fetch } = {}) {
		this.fetchImpl = options.fetch;
	}

	/** Called on every activation while `brain` is on. */
	attach(host: EeHost): void {
		const api = host.veyraApi("brain");
		if (api?.baseUrl !== this.api?.baseUrl) this.providers.clear();
		this.api = api;
		host.registerMemoryProvider("brain", (context) => this.provider(context));
		host.registerCommand("memory", (context) => this.command(context));
	}

	/** Brain is off: forget the sign-in's API (the core already stopped asking for providers). */
	reset(): void {
		this.api = undefined;
		this.providers.clear();
	}

	/**
	 * The core's factory: a provider for a repository in the signed-in organization; none outside a repository, when
	 * paused, without a sign-in or without an organization. A provider is never reused for another organization.
	 */
	provider(context: MemoryProviderContext): MemoryProvider | undefined {
		const api = this.api;
		const repository = context.repository;
		const org = api?.org;
		if (!api || !org || !repository || this.paused.has(repository)) return undefined;
		const cacheKey = `${org}:${repository}`;
		let provider = this.providers.get(cacheKey);
		if (!provider) {
			provider = new BrainMemoryProvider({
				api,
				org,
				repository,
				scope: shortName(repository),
				fetch: this.fetchImpl,
			});
			this.providers.set(cacheKey, provider);
		}
		return provider;
	}

	async command(context: EeCommandContext): Promise<void> {
		const [verb = "", ...rest] = context.args.split(/\s+/);
		const text = context.args.slice(verb.length).trim();
		const repository = context.repository;
		if (!repository) {
			context.showWarning(
				"Brain memory needs a git repository with a remote (origin): this directory has none, so there is no project memory here.",
			);
			return;
		}
		const name = shortName(repository);
		switch (verb) {
			case "": {
				if (this.paused.has(repository)) {
					context.showStatus(`Brain memory is off for “${name}” in this session. /memory on turns it back on.`);
					return;
				}
				context.showStatus(
					`Brain memory is on for “${name}” (${repository}): each task starts with what Brain remembers for it, the model can recall and remember, and Brain learns from how tasks end. /memory off turns it off for this session.`,
				);
				return;
			}
			case "off":
				this.paused.add(repository);
				context.showStatus(`Brain memory is off for “${name}” until you run /memory on or restart Fingers.`);
				return;
			case "on":
				this.paused.delete(repository);
				context.showStatus(`Brain memory is on for “${name}”.`);
				return;
			case "recall":
			case "remember": {
				if (!rest.length || !text) {
					context.showWarning(USAGE);
					return;
				}
				const provider = this.provider({ cwd: context.cwd, repository });
				if (!provider) {
					context.showWarning(
						this.paused.has(repository)
							? `Brain memory is off for “${name}”. /memory on turns it back on.`
							: "Brain memory is not available: sign in again with /login.",
					);
					return;
				}
				const signal = AbortSignal.timeout(10_000);
				try {
					if (verb === "recall") {
						const items = await provider.recall({ query: text, limit: 8 }, { signal });
						if (items.length === 0)
							context.showStatus(`Brain remembers nothing for “${oneLine(text, 80)}” in “${name}”.`);
						else
							context.showStatus(
								[
									`Brain, “${name}”: ${items.length} item${items.length === 1 ? "" : "s"}`,
									...items.map((item) => `  ${oneLine(item.kind, 20)} · ${oneLine(item.text)}`),
								].join("\n"),
							);
					} else {
						const saved = await provider.remember({ type: "fact", text }, { signal });
						const merged = saved.merged_into ? `, merged into ${oneLine(saved.merged_into, 40)}` : "";
						context.showStatus(`Saved to Brain for “${name}” (${oneLine(saved.id, 40)}${merged}).`);
					}
				} catch (error) {
					context.showWarning(
						`Brain memory is unavailable: ${oneLine(error instanceof Error ? error.message : String(error))}`,
					);
				}
				return;
			}
			default:
				context.showWarning(USAGE);
		}
	}
}
