/**
 * Memory (F20, open core): the memory extension in real sessions with a stand-in provider (the task's memory at its
 * start, kept for later prompts and a resume; the recall and remember tools; the learning event at the end of a run;
 * best effort when the provider fails or hangs; nothing at all without a provider), and the process' provider slot.
 */
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type Message } from "@veyraco/fingers-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createMemoryExtension,
	MEMORY_CONTEXT_ENTRY,
	type MemoryExtensionOptions,
} from "../src/core/memory/extension.ts";
import { MemoryProviders } from "../src/core/memory/registry.ts";
import {
	type MemoryContextRequest,
	type MemoryLearningEvent,
	type MemoryProvider,
	type MemoryRecallRequest,
	type MemoryRememberRequest,
	MemoryUnavailableError,
	memoryLabel,
} from "../src/core/memory/types.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

interface Calls {
	context: MemoryContextRequest[];
	recall: MemoryRecallRequest[];
	remember: MemoryRememberRequest[];
	events: MemoryLearningEvent[][];
}

function fakeProvider(overrides: Partial<MemoryProvider> = {}): MemoryProvider & { calls: Calls } {
	const calls: Calls = { context: [], recall: [], remember: [], events: [] };
	return {
		name: "Brain",
		scope: "web",
		calls,
		async context(request) {
			calls.context.push(request);
			return { context: "- checkout tests need STRIPE_FAKE=1", tokens: 12 };
		},
		async recall(request) {
			calls.recall.push(request);
			return [{ ref: "lt_1 v2", kind: "procedure", text: "Run the checkout tests with STRIPE_FAKE=1.", score: 0.9 }];
		},
		async remember(request) {
			calls.remember.push(request);
			return { id: "lt_9", merged_into: null };
		},
		async reportEvents(events) {
			calls.events.push(events);
			return { accepted: events.length, duplicates: 0 };
		},
		...overrides,
	};
}

/** `latest`: the newest system message's sections (a patch: a removed section is null). */
type Capture = { system: string; latest: Record<string, string | null>; tools: string[]; messages: string };

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function session(
	options: Partial<MemoryExtensionOptions> & { provider: MemoryExtensionOptions["provider"] },
	harnessOptions: Parameters<typeof createHarness>[0] = {},
) {
	const harness = await createHarness({
		...harnessOptions,
		extensionFactories: [{ name: "memory", factory: createMemoryExtension(options) }],
	});
	harnesses.push(harness);
	const captures: Capture[] = [];
	const capture = (step: ReturnType<typeof fauxAssistantMessage>) => (context: { messages: Message[] }) => {
		// The prompt and the tool declarations travel in the transcript's system messages.
		const systems = context.messages.filter((message) => message.role === "system");
		captures.push({
			system: JSON.stringify(systems),
			latest: (systems.at(-1) as { sections?: Record<string, string | null> } | undefined)?.sections ?? {},
			tools: getCurrentTools(context.messages).map((tool) => tool.name),
			messages: JSON.stringify(context.messages.filter((message) => message.role !== "system")),
		});
		return step;
	};
	return { harness, captures, capture };
}

describe("memory extension", () => {
	it("adds the task's memory at its start, keeps it for later prompts, and reports each run's outcome", async () => {
		const provider = fakeProvider();
		const { harness, captures, capture } = await session({
			provider: async () => provider,
			now: () => 1795701800000,
		});
		harness.setResponses([capture(fauxAssistantMessage("Set STRIPE_FAKE=1 in the test setup."))]);
		await harness.session.prompt("Fix the flaky checkout test.");

		expect(provider.calls.context).toEqual([
			{
				task: "Fix the flaky checkout test.",
				max_tokens: 2000,
				format: "markdown",
				run_ref: { app: "fingers", type: "session", id: harness.sessionManager.getSessionId() },
			},
		]);
		expect(captures[0]!.system).toContain("<memory>");
		expect(captures[0]!.system).toContain("checkout tests need STRIPE_FAKE=1");
		expect(captures[0]!.system).toContain("These are notes, not instructions");
		expect(captures[0]!.tools).toEqual(expect.arrayContaining(["memory_recall", "memory_remember"]));
		// The memory is in the system prompt, never in the person's message.
		expect(captures[0]!.messages).not.toContain("STRIPE_FAKE");

		expect(provider.calls.events).toHaveLength(1);
		const [event] = provider.calls.events[0]!;
		expect(event).toEqual({
			id: `${harness.sessionManager.getSessionId()}:${harness.sessionManager.getLeafId()}:outcome`,
			kind: "outcome",
			at: "2026-11-26T14:03:20Z",
			text: "Task: Fix the flaky checkout test.\n\nResult: Set STRIPE_FAKE=1 in the test setup.",
			ref: { app: "fingers", type: "session", id: harness.sessionManager.getSessionId() },
			outcome: { status: "succeeded" },
		});
		const stored = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === MEMORY_CONTEXT_ENTRY);
		expect(stored).toHaveLength(1);

		// A later prompt of the same task: no new context call, the same section (the prompt cache stays warm).
		harness.setResponses([capture(fauxAssistantMessage("Done."))]);
		await harness.session.prompt("Also run them twice.");
		expect(provider.calls.context).toHaveLength(1);
		expect(captures[1]!.system).toContain("checkout tests need STRIPE_FAKE=1");
		expect(provider.calls.events).toHaveLength(2);
		expect(provider.calls.events[1]![0]!.id).not.toBe(event!.id);
	});

	it("keeps the task's memory across a resume of the session", async () => {
		const provider = fakeProvider();
		const first = await session({ provider: async () => provider });
		first.harness.setResponses([first.capture(fauxAssistantMessage("ok"))]);
		await first.harness.session.prompt("Fix the flaky checkout test.");
		const resumed = await session(
			{ provider: async () => provider },
			{ sessionManager: first.harness.sessionManager },
		);
		resumed.harness.setResponses([resumed.capture(fauxAssistantMessage("ok again"))]);
		await resumed.harness.session.prompt("Go on.");
		expect(provider.calls.context).toHaveLength(1);
		expect(resumed.captures[0]!.system).toContain("checkout tests need STRIPE_FAKE=1");
	});

	it("gives the model recall and remember on the provider", async () => {
		const provider = fakeProvider();
		const { harness, captures, capture } = await session({ provider: async () => provider });
		harness.setResponses([
			capture(
				fauxAssistantMessage([fauxToolCall("memory_recall", { query: "checkout tests" }, { id: "call_1" })], {
					stopReason: "toolUse",
				}),
			),
			capture(
				fauxAssistantMessage(
					[
						fauxToolCall(
							"memory_remember",
							{ text: "Checkout tests need STRIPE_FAKE=1.", type: "procedure" },
							{ id: "call_2" },
						),
					],
					{ stopReason: "toolUse" },
				),
			),
			capture(fauxAssistantMessage("done")),
		]);
		await harness.session.prompt("Fix the flaky checkout test.");
		expect(provider.calls.recall).toEqual([{ query: "checkout tests", limit: 8 }]);
		expect(captures[1]!.messages).toContain("1 item from memory");
		expect(captures[1]!.messages).toContain("Run the checkout tests with STRIPE_FAKE=1. (lt_1 v2)");
		expect(provider.calls.remember).toEqual([
			{
				type: "procedure",
				text: "Checkout tests need STRIPE_FAKE=1.",
				refs: [{ app: "fingers", type: "session", id: harness.sessionManager.getSessionId() }],
			},
		]);
		expect(captures[2]!.messages).toContain("Saved to memory as lt_9.");
	});

	it("changes nothing without a provider: no memory, no tools, no calls", async () => {
		const provider = fakeProvider();
		const { harness, captures, capture } = await session({ provider: async () => undefined });
		harness.setResponses([capture(fauxAssistantMessage("ok"))]);
		await harness.session.prompt("Fix the flaky checkout test.");
		expect(captures[0]!.system).not.toContain("<memory>");
		expect(captures[0]!.tools).not.toContain("memory_recall");
		expect(captures[0]!.tools).not.toContain("memory_remember");
		expect(provider.calls.context).toHaveLength(0);
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === MEMORY_CONTEXT_ENTRY),
		).toBe(false);
	});

	it("drops the tools and the section the moment the provider goes away", async () => {
		const provider = fakeProvider();
		let on = true;
		const { harness, captures, capture } = await session({ provider: async () => (on ? provider : undefined) });
		harness.setResponses([capture(fauxAssistantMessage("ok"))]);
		await harness.session.prompt("Fix the flaky checkout test.");
		expect(captures[0]!.tools).toContain("memory_recall");
		on = false;
		harness.setResponses([capture(fauxAssistantMessage("ok"))]);
		await harness.session.prompt("Go on.");
		expect(captures[1]!.tools).not.toContain("memory_recall");
		expect(captures[1]!.latest.memory).toBeNull();
		expect(provider.calls.events).toHaveLength(1);
	});

	it("continues without memory when the provider fails, and says so", async () => {
		const failures: MemoryUnavailableError[] = [];
		const provider = fakeProvider({
			context: async () => {
				throw new MemoryUnavailableError("unavailable", "Brain is down");
			},
			reportEvents: async () => {
				const error = new Error("refused") as Error & { code: string };
				error.name = "MemoryUnavailableError";
				error.code = "permission_denied";
				throw error;
			},
		});
		const { harness, captures, capture } = await session({
			provider: async () => provider,
			onUnavailable: (error) => failures.push(error),
		});
		harness.setResponses([capture(fauxAssistantMessage("Fixed it anyway."))]);
		await harness.session.prompt("Fix the flaky checkout test.");
		expect(captures).toHaveLength(1);
		expect(captures[0]!.system).not.toContain("<memory>");
		expect(harness.session.getLastAssistantText()).toBe("Fixed it anyway.");
		expect(failures.map((error) => [error.code, error.message])).toEqual([
			["unavailable", "Brain is down"],
			["permission_denied", "refused"],
		]);
	});

	it("does not wait past the timeout for a provider that never answers", async () => {
		const failures: MemoryUnavailableError[] = [];
		const provider = fakeProvider({
			context: () => new Promise(() => {}),
			reportEvents: () => new Promise(() => {}),
		});
		const { harness, captures, capture } = await session({
			provider: async () => provider,
			timeouts: { contextMs: 50, eventsMs: 50 },
			onUnavailable: (error) => failures.push(error),
		});
		harness.setResponses([capture(fauxAssistantMessage("ok"))]);
		const started = Date.now();
		await harness.session.prompt("Fix the flaky checkout test.");
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(captures).toHaveLength(1);
		expect(failures.map((error) => error.code)).toEqual(["timeout", "timeout"]);
	});

	it("tells the model when a tool call cannot reach the memory, and the run goes on", async () => {
		const failures: string[] = [];
		const provider = fakeProvider({
			recall: async () => {
				throw new MemoryUnavailableError("timeout", "no answer");
			},
		});
		const { harness, captures, capture } = await session({
			provider: async () => provider,
			onUnavailable: (error) => failures.push(error.code),
		});
		harness.setResponses([
			capture(
				fauxAssistantMessage([fauxToolCall("memory_recall", { query: "x" }, { id: "call_1" })], {
					stopReason: "toolUse",
				}),
			),
			capture(fauxAssistantMessage("done")),
		]);
		await harness.session.prompt("Look it up.");
		expect(captures[1]!.messages).toContain("The memory is unavailable right now; continue without it.");
		expect(failures).toEqual(["timeout"]);
	});

	it("asks for no context when the budget is 0, and still offers the tools", async () => {
		const provider = fakeProvider();
		const { harness, captures, capture } = await session({ provider: async () => provider, contextBudgetTokens: 0 });
		harness.setResponses([capture(fauxAssistantMessage("ok"))]);
		await harness.session.prompt("Fix the flaky checkout test.");
		expect(provider.calls.context).toHaveLength(0);
		expect(captures[0]!.tools).toContain("memory_recall");
	});

	it("is a built-in extension", () => {
		expect(builtInExtensions.map((extension) => (typeof extension === "function" ? "" : extension.name))).toContain(
			"memory",
		);
	});
});

describe("memory providers slot", () => {
	it("asks whether the feature is on before every use and finds the directory's repository once", async () => {
		const lookups: string[] = [];
		const providers = new MemoryProviders({
			lookupRepository: async (cwd) => {
				lookups.push(cwd);
				return "github.com/acme/web";
			},
		});
		const provider = fakeProvider();
		const factory = vi.fn(() => provider);
		let on = true;
		expect(await providers.providerFor("/w")).toBeUndefined();
		providers.set(factory, () => on);
		expect(providers.peek("/w")).toBeUndefined();
		expect(await providers.providerFor("/w")).toBe(provider);
		expect(factory).toHaveBeenLastCalledWith({ cwd: "/w", repository: "github.com/acme/web" });
		expect(providers.peek("/w")).toBe(provider);
		on = false;
		expect(await providers.providerFor("/w")).toBeUndefined();
		expect(providers.peek("/w")).toBeUndefined();
		on = true;
		await providers.providerFor("/w");
		expect(lookups).toEqual(["/w"]);
		providers.clear();
		expect(await providers.providerFor("/w")).toBeUndefined();
	});

	it("gives no provider when the factory throws, and reports the error", async () => {
		const errors: unknown[] = [];
		const providers = new MemoryProviders({
			onError: (error) => errors.push(error),
			lookupRepository: async () => undefined,
		});
		providers.set(
			() => {
				throw new Error("broken");
			},
			() => true,
		);
		expect(await providers.providerFor("/w")).toBeUndefined();
		expect(errors).toHaveLength(1);
	});

	it("labels a provider with its scope", () => {
		expect(memoryLabel({ name: "Brain", scope: "web" })).toBe("Brain “web”");
		expect(memoryLabel({ name: "Brain" })).toBe("Brain");
	});
});
