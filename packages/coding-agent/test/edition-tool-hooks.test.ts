/**
 * Open core: ee features act on a session only through the tool hooks the gate hands the built-in `edition`
 * extension, and only while the feature is on. These tests use stand-in ee modules, so they pass without ee/.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@veyraco/fingers-agent";
import { fauxAssistantMessage, fauxToolCall } from "@veyraco/fingers-ai";
import { afterEach, describe, expect, it } from "vitest";
import { estimateTokens } from "../src/core/compaction/index.ts";
import {
	EditionGate,
	EditionToolHooks,
	type EeContextEntry,
	type EeContextView,
	type EeEntitlement,
	type EeFeatureId,
	type EeModule,
	type EeToolHooks,
	type EeToolResult,
	type VeyraTier,
} from "../src/core/edition/index.ts";
import { SavingsLedger } from "../src/core/savings-ledger.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createEditionExtension } from "../src/extensions/edition/index.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

/** The built-in read tool as the harness takes it: `AgentTool<any>`, the type `createCodingTools` gives its tools. */
const readTool = (): AgentTool<any> => createReadTool(process.cwd());

const MATRIX: Record<EeFeatureId, VeyraTier> = {
	token_saving: "low",
	subagents: "medium",
	checkpoints: "medium",
	brain: "medium",
	eyes: "medium",
	org_hooks: "high",
};

function signedIn(tier: string): EeEntitlement {
	return { signedIn: true, source: "connect", org: "org_1", orgName: "Acme", tier, fingersEnabled: true };
}

/** A stand-in ee module that registers `hooks` for token saving, and one for org hooks (High). */
function moduleWith(hooks: EeToolHooks, orgHooks: EeToolHooks = {}): EeModule {
	return {
		apiVersion: 7,
		matrixVersion: "test.1",
		minimumTier: (feature) => MATRIX[feature],
		activate: (host) => {
			host.registerToolHooks("token_saving", hooks);
			host.registerToolHooks("org_hooks", orgHooks);
			if (host.isOn("token_saving")) host.recordSaving({ technique: "read_cache", tokens: 10 });
		},
	};
}

function toolResult(overrides: Partial<EeToolResult> = {}): EeToolResult {
	return {
		toolName: "bash",
		toolCallId: "call_1",
		nested: false,
		input: {},
		content: [{ type: "text", text: "long output" }],
		isError: false,
		cwd: "/work",
		...overrides,
	};
}

const REPLACE: EeToolHooks = { toolResult: () => ({ content: [{ type: "text", text: "trimmed by ee" }] }) };

describe("EditionGate tool hooks", () => {
	it("hands the extension the hooks of the features that are on, and none while signed out or below the tier", async () => {
		const hooks = new EditionToolHooks();
		const savings = new SavingsLedger();
		const resets: string[] = [];
		const gate = new EditionGate({
			loadModule: async () =>
				moduleWith(
					{ ...REPLACE, contextReset: () => resets.push("token_saving") },
					{ ...REPLACE, contextReset: () => resets.push("org_hooks") },
				),
			toolHooks: hooks,
			savings,
		});

		await gate.setEntitlement(signedIn("free"));
		expect(hooks.active).toBe(false);
		expect(await hooks.toolResult(toolResult())).toBeUndefined();
		expect(savings.totals().tokens).toBe(0);

		await gate.setEntitlement(signedIn("low"));
		expect(hooks.active).toBe(true);
		expect(await hooks.toolResult(toolResult())).toEqual({ content: [{ type: "text", text: "trimmed by ee" }] });
		expect(savings.totals().byTechnique.read_cache).toEqual({ tokens: 10, costUsd: 0, count: 1 });
		// Low includes token saving only: the org hooks were never registered, so not even a context reset reaches them.
		hooks.contextReset();
		expect(resets).toEqual(["token_saving"]);

		await gate.setEntitlement({ signedIn: false, source: "none", fingersEnabled: false });
		expect(hooks.active).toBe(false);
		expect(await hooks.toolResult(toolResult())).toBeUndefined();
	});

	it("drops the hooks when Fingers is turned off for the organization or the module fails to activate", async () => {
		const hooks = new EditionToolHooks();
		const gate = new EditionGate({ loadModule: async () => moduleWith(REPLACE), toolHooks: hooks });
		await gate.setEntitlement(signedIn("low"));
		expect(hooks.active).toBe(true);
		await gate.setEntitlement({ ...signedIn("low"), fingersEnabled: false });
		expect(hooks.active).toBe(false);

		const broken = new EditionToolHooks();
		const errors: unknown[] = [];
		const failing = new EditionGate({
			loadModule: async () => ({
				...moduleWith(REPLACE),
				activate: (host) => {
					host.registerToolHooks("token_saving", REPLACE);
					throw new Error("broken ee");
				},
			}),
			toolHooks: broken,
			onActivateError: (error) => errors.push(error),
		});
		await failing.setEntitlement(signedIn("high"));
		expect(broken.active).toBe(false);
		expect(errors).toHaveLength(1);
	});

	it("checks the feature again on every call", async () => {
		const hooks = new EditionToolHooks();
		let on = true;
		hooks.set([{ feature: "token_saving", hooks: REPLACE }], () => on);
		expect(await hooks.toolResult(toolResult())).toBeDefined();
		on = false;
		expect(hooks.active).toBe(false);
		expect(await hooks.toolResult(toolResult())).toBeUndefined();
	});
});

describe("EditionToolHooks", () => {
	it("chains hooks in order, skips one that throws, and tells every hook about a context reset", async () => {
		const errors: unknown[] = [];
		const hooks = new EditionToolHooks({ onError: (error) => errors.push(error) });
		const resets: string[] = [];
		hooks.set(
			[
				{
					feature: "token_saving",
					hooks: {
						toolResult: (result) => ({
							content: [{ type: "text", text: `${(result.content[0] as { text: string }).text} + a` }],
						}),
						contextReset: () => resets.push("a"),
					},
				},
				{
					feature: "token_saving",
					hooks: {
						toolResult: () => {
							throw new Error("hook failed");
						},
						contextReset: () => {
							throw new Error("reset failed");
						},
					},
				},
				{
					feature: "org_hooks",
					hooks: {
						toolResult: (result) => ({
							content: [{ type: "text", text: `${(result.content[0] as { text: string }).text} + b` }],
						}),
						contextReset: () => resets.push("b"),
					},
				},
			],
			() => true,
		);
		expect(await hooks.toolResult(toolResult())).toEqual({
			content: [{ type: "text", text: "long output + a + b" }],
		});
		hooks.contextReset();
		expect(resets).toEqual(["a", "b"]);
		expect(errors).toHaveLength(2);
	});
});

describe("EditionToolHooks context hooks (F15)", () => {
	const entry = (id: string, role: EeContextEntry["role"] = "toolResult"): EeContextEntry => ({
		id,
		role,
		tokens: 500,
		edited: false,
		...(role === "toolResult"
			? { toolName: "read", content: [{ type: "text" as const, text: "x".repeat(2000) }] }
			: {}),
	});
	const view = (entries: EeContextEntry[]): EeContextView => ({
		entries,
		tokens: 30_000,
		contextWindow: 40_000,
		compaction: { enabled: true, reserveTokens: 4000, keepRecentTokens: 8000 },
		cwd: "/work",
	});
	const note = (text: string) => [{ type: "text" as const, text }];

	it("keeps only edits of tool results in the view, once per target, and chains hooks on the edited view", () => {
		const hooks = new EditionToolHooks();
		const second: EeContextEntry[][] = [];
		hooks.set(
			[
				{
					feature: "token_saving",
					hooks: {
						contextEdits: () => [
							{ targetId: "r1", content: note("pruned r1") },
							{ targetId: "r1", content: note("again") },
							{ targetId: "a1", content: note("an assistant message") },
							{ targetId: "missing", content: note("not in the view") },
							{ targetId: "r2", content: [{ type: "video", url: "x" }] as never },
						],
					},
				},
				{
					feature: "org_hooks",
					hooks: {
						contextEdits: (seen) => {
							second.push([...seen.entries]);
							return [
								{ targetId: "r1", content: note("a later hook cannot edit it twice") },
								{ targetId: "r2", content: note("pruned r2") },
							];
						},
					},
				},
				{
					feature: "token_saving",
					hooks: {
						contextEdits: () => {
							throw new Error("broken hook");
						},
					},
				},
			],
			() => true,
		);
		const edits = hooks.contextEdits(view([entry("u0", "user"), entry("a1", "assistant"), entry("r1"), entry("r2")]));
		expect(edits).toEqual([
			{ targetId: "r1", content: note("pruned r1") },
			{ targetId: "r2", content: note("pruned r2") },
		]);
		// The second hook saw r1 already edited, with the note's size.
		expect(second[0]?.find((seen) => seen.id === "r1")).toMatchObject({
			edited: true,
			tokens: 3,
			content: note("pruned r1"),
		});
	});

	it("asks only features that are on, collects compaction lines, keeps notices once, and reports changes", () => {
		const hooks = new EditionToolHooks();
		const changes: number[] = [];
		const stop = hooks.onChange(() => changes.push(changes.length));
		expect(hooks.hasContextHooks).toBe(false);
		let on = true;
		hooks.set(
			[
				{
					feature: "token_saving",
					hooks: {
						contextEdits: () => [{ targetId: "r1", content: note("pruned") }],
						beforeCompact: () => "should save about 9 tokens",
						afterCompact: () => "saved 8 tokens",
					},
				},
			],
			() => on,
		);
		expect(hooks.hasContextHooks).toBe(true);
		const preview = {
			reason: "manual" as const,
			tokensBefore: 10,
			summarizedTokens: 9,
			previousSummaryTokens: 0,
			fileListTokens: 0,
			splitTurn: false,
			summaryMaxTokens: 100,
		};
		expect(hooks.beforeCompact(preview)).toEqual(["should save about 9 tokens"]);
		expect(hooks.afterCompact({ reason: "manual", tokensBefore: 10, tokensAfter: 2, summaryTokens: 1 })).toEqual([
			"saved 8 tokens",
		]);
		on = false;
		expect(hooks.contextEdits(view([entry("r1")]))).toEqual([]);
		expect(hooks.beforeCompact(preview)).toEqual([]);
		hooks.addNotices(["one", "two"]);
		expect(hooks.takeNotices()).toEqual(["one", "two"]);
		expect(hooks.takeNotices()).toEqual([]);
		hooks.clear();
		expect(hooks.hasContextHooks).toBe(false);
		expect(changes).toEqual([0, 1]);
		stop();
		hooks.clear();
		expect(changes).toEqual([0, 1]);
	});
});

describe("SavingsLedger", () => {
	it("adds up entries per technique and ignores entries that save nothing", () => {
		const ledger = new SavingsLedger({ now: () => 5 });
		ledger.record({ technique: "read_cache", tokens: 120.7, toolCallId: "c1", toolName: "read" });
		ledger.record({ technique: "output_trim", tokens: 30 });
		ledger.record({ technique: "read_cache", tokens: 5 });
		ledger.record({ technique: "diff_edit", tokens: 0 });
		ledger.record({ technique: "diff_edit", tokens: Number.NaN });
		ledger.record({ technique: "nonsense" as never, tokens: 50 });
		ledger.record({ technique: "context_prune", tokens: 40, toolCallId: "c9", toolName: "bash" });
		// Model routing saves dollars, not tokens: an entry with only a positive cost counts.
		ledger.record({ technique: "model_routing", tokens: 0, costUsd: 0.25 });
		ledger.record({ technique: "model_routing", tokens: 0, costUsd: 0.5 });
		ledger.record({ technique: "model_routing", tokens: 0, costUsd: -1 });
		ledger.record({ technique: "model_routing", tokens: 0, costUsd: Number.POSITIVE_INFINITY });
		expect(ledger.totals()).toEqual({
			byTechnique: {
				read_cache: { tokens: 125, costUsd: 0, count: 2 },
				output_trim: { tokens: 30, costUsd: 0, count: 1 },
				diff_edit: { tokens: 0, costUsd: 0, count: 0 },
				context_prune: { tokens: 40, costUsd: 0, count: 1 },
				model_routing: { tokens: 0, costUsd: 0.75, count: 2 },
			},
			tokens: 195,
			costUsd: 0.75,
		});
		expect(ledger.entries().at(-1)).toEqual({ technique: "model_routing", tokens: 0, costUsd: 0.5, at: 5 });
		expect(ledger.entries()[0]).toEqual({
			technique: "read_cache",
			tokens: 120,
			toolCallId: "c1",
			toolName: "read",
			at: 5,
		});
		ledger.clear();
		expect(ledger.totals().tokens).toBe(0);
	});
});

describe("the edition extension in a session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("is a built-in extension", () => {
		expect(builtInExtensions.map((extension) => (typeof extension === "function" ? "" : extension.name))).toContain(
			"edition",
		);
	});

	async function readTwice(hooks: EditionToolHooks, savings = new SavingsLedger()) {
		const harness = await createHarness({
			tools: [readTool()],
			extensionFactories: [{ name: "edition", factory: createEditionExtension({ hooks, savings }) }],
		});
		harnesses.push(harness);
		const file = join(harness.tempDir, "notes.txt");
		writeFileSync(file, "the file body\n");
		const requests: string[] = [];
		const systemPrompts: string[] = [];
		const capture =
			(text: string, toolCall?: ReturnType<typeof fauxToolCall>) => (context: { messages: unknown[] }) => {
				requests.push(JSON.stringify(context.messages));
				systemPrompts.push(JSON.stringify(context));
				return toolCall ? fauxAssistantMessage([toolCall], { stopReason: "toolUse" }) : fauxAssistantMessage(text);
			};
		harness.setResponses([capture("", fauxToolCall("read", { path: file })), capture("done")]);
		await harness.session.prompt("read the notes");
		return { harness, file, requests, systemPrompts };
	}

	it("passes the read result to the hooks with the resolved path, and the model gets the hook's content", async () => {
		const hooks = new EditionToolHooks();
		const seen: EeToolResult[] = [];
		hooks.set(
			[
				{
					feature: "token_saving",
					hooks: {
						toolResult: (result) => {
							seen.push(result);
							return { content: [{ type: "text", text: "[from cache, read once] stand-in" }] };
						},
						toolGuidelines: () => ({ read: ["Stand-in guideline for read."], nosuchtool: ["never shown"] }),
					},
				},
			],
			() => true,
		);
		const { file, requests, systemPrompts } = await readTwice(hooks);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ toolName: "read", nested: false, isError: false, path: file });
		expect(requests[1]).toContain("[from cache, read once] stand-in");
		expect(requests[1]).not.toContain("the file body");
		expect(systemPrompts[0]).toContain("Stand-in guideline for read.");
		expect(systemPrompts[0]).not.toContain("never shown");
	});

	it("changes nothing without hooks (core only)", async () => {
		const { requests, systemPrompts } = await readTwice(new EditionToolHooks());
		expect(requests[1]).toContain("the file body");
		expect(systemPrompts[0]).not.toContain("Stand-in guideline");
	});

	it("listens to turn ends only while a hook edits the context", async () => {
		const hooks = new EditionToolHooks();
		const { harness } = await readTwice(hooks);
		const runner = harness.session.extensionRunner;
		expect(runner.hasHandlers("turn_end")).toBe(false);
		hooks.set([{ feature: "token_saving", hooks: { contextEdits: () => [] } }], () => true);
		expect(runner.hasHandlers("turn_end")).toBe(true);
		hooks.set([{ feature: "token_saving", hooks: { toolResult: () => undefined } }], () => true);
		expect(runner.hasHandlers("turn_end")).toBe(false);
	});

	it("saves the hook's context edits at the end of a turn, and every later request gets the replacement", async () => {
		const hooks = new EditionToolHooks();
		const views: EeContextView[] = [];
		hooks.set(
			[
				{
					feature: "token_saving",
					hooks: {
						contextEdits: (seen) => {
							views.push(seen);
							const read = seen.entries.find((candidate) => candidate.toolName === "read" && !candidate.edited);
							return read ? [{ targetId: read.id, content: [{ type: "text", text: "[pruned] stand-in" }] }] : [];
						},
					},
				},
			],
			() => true,
		);
		const { harness, file, requests } = await readTwice(hooks);
		// The edit came at the end of the read's turn: the answer request already has the replacement.
		expect(requests[0]).not.toContain("the file body");
		expect(requests[1]).toContain("[pruned] stand-in");
		expect(requests[1]).not.toContain("the file body");
		const read = views[0]?.entries.find((candidate) => candidate.role === "toolResult");
		expect(read).toMatchObject({
			toolName: "read",
			path: file,
			input: { path: file },
			isError: false,
			edited: false,
			content: [{ type: "text", text: "the file body\n" }],
		});
		expect(views[0]).toMatchObject({
			contextWindow: harness.getModel().contextWindow,
			compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
			cwd: harness.tempDir,
		});
		expect(views[0]?.tokens).toBeGreaterThan(0);
		const edits = harness.sessionManager.getEntries().filter((entry) => entry.type === "context_edit");
		expect(edits).toHaveLength(1);
		expect(edits[0]).toMatchObject({ targetId: read?.id, replacement: { content: [{ text: "[pruned] stand-in" }] } });
		// The next turn sees it as edited.
		expect(views.at(-1)?.entries.find((candidate) => candidate.id === read?.id)).toMatchObject({ edited: true });
	});

	it("hands the hooks the compaction settings of the session, model overrides included", async () => {
		const hooks = new EditionToolHooks();
		const views: EeContextView[] = [];
		const contextEdits = (seen: EeContextView) => {
			views.push(seen);
			return [];
		};
		hooks.set([{ feature: "token_saving", hooks: { contextEdits } }], () => true);
		const harness = await createHarness({
			tools: [readTool()],
			extensionFactories: [{ name: "edition", factory: createEditionExtension({ hooks }) }],
		});
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.applyOverrides({
			compaction: {
				reserveTokens: 1000,
				keepRecentTokens: 2000,
				modelOverrides: { [`${model.provider}/${model.id}`]: { keepRecentTokens: 3000 } },
			},
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "nope.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		]);
		await harness.session.prompt("read");
		expect(views[0]?.compaction).toEqual({ enabled: true, reserveTokens: 1000, keepRecentTokens: 3000 });
		expect(views[0]?.entries.find((candidate) => candidate.role === "toolResult")).toMatchObject({ isError: true });
	});

	it("measures a compaction for the hooks, shows the line before it and keeps the line after it for the terminal", async () => {
		const hooks = new EditionToolHooks();
		const previews: unknown[] = [];
		const outcomes: { tokensBefore: number; tokensAfter: number; summaryTokens: number }[] = [];
		hooks.set(
			[
				{
					feature: "token_saving",
					hooks: {
						beforeCompact: (preview) => {
							previews.push(preview);
							return "before line";
						},
						afterCompact: (outcome) => {
							outcomes.push(outcome);
							return "after line";
						},
					},
				},
			],
			() => true,
		);
		const { harness } = await readTwice(hooks);
		const notices: string[] = [];
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({ notify: (message) => notices.push(message) }),
		});
		harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		harness.setResponses([fauxAssistantMessage("summary")]);
		const measure = () =>
			harness.sessionManager
				.buildSessionProjection()
				.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
		const before = measure();
		await harness.session.compact();
		expect(previews).toHaveLength(1);
		expect(previews[0]).toMatchObject({ reason: "manual", previousSummaryTokens: 0, summaryMaxTokens: 13107 });
		expect((previews[0] as { summarizedTokens: number }).summarizedTokens).toBeGreaterThan(0);
		expect(notices).toEqual(["before line"]);
		expect(hooks.takeNotices()).toEqual(["after line"]);
		// Both sides measured the same way: chars/4 of everything the model gets.
		expect(outcomes[0]).toMatchObject({ reason: "manual", tokensBefore: before, tokensAfter: measure() });
		expect((previews[0] as { tokensBefore: number }).tokensBefore).toBe(before);
		expect(outcomes[0]?.summaryTokens).toBe(
			Math.ceil(
				(
					harness.sessionManager.getEntries().findLast((entry) => entry.type === "compaction") as {
						summary: string;
					}
				).summary.length / 4,
			),
		);
	});

	it("tells the hooks when compaction rebuilds the context, and keeps the ledger of the conversation", async () => {
		const hooks = new EditionToolHooks();
		let resets = 0;
		hooks.set([{ feature: "token_saving", hooks: { contextReset: () => resets++ } }], () => true);
		const savings = new SavingsLedger();
		const { harness } = await readTwice(hooks, savings);
		const before = resets;
		harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		savings.record({ technique: "read_cache", tokens: 9 });
		harness.setResponses([fauxAssistantMessage("summary")]);
		await harness.session.compact();
		expect(resets).toBe(before + 1);
		expect(savings.totals().tokens).toBe(9);
	});
});
