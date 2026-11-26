/**
 * F17: the savings ledger priced at the model in use and kept in the session file, and the token-saving report
 * (canvas FingersTuiSavings) built from a recorded task. The report's ee rows add up to the ledger's totals.
 */
import type { AgentTool } from "@veyraco/fingers-agent";
import type { AssistantMessage, ToolCall, Usage } from "@veyraco/fingers-ai";
import { fauxAssistantMessage, fauxToolCall } from "@veyraco/fingers-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { EditionToolHooks } from "../src/core/edition/index.ts";
import { savingsLedger } from "../src/core/edition/tool-hooks.ts";
import {
	parseSavingsRecord,
	SAVINGS_ENTRY_TYPE,
	SAVINGS_TECHNIQUES,
	SavingsLedger,
	type SavingsPricing,
	savingCostUsd,
} from "../src/core/savings-ledger.ts";
import {
	computeSavingsReport,
	runSavingsLine,
	type SavingsPriceSource,
	type SavingsReportInput,
	savingsReportText,
	withoutSignInText,
} from "../src/core/savings-report.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { TelemetryExporters } from "../src/core/tracing/registry.ts";
import { createEditionExtension, savingsOnBranch, savingsPricing } from "../src/extensions/edition/index.ts";
import { SavingsReportComponent } from "../src/modes/interactive/components/savings-report.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const SONNET: SavingsPricing = { provider: "anthropic", model: "claude-sonnet", inputPerMTok: 3, outputPerMTok: 15 };

const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
	"anthropic/claude-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	"openrouter/deepseek-chat": { input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0 },
};

const prices: SavingsPriceSource = {
	getModel: (provider, id) => {
		const cost = PRICES[`${provider}/${id}`];
		return cost ? { cost } : undefined;
	},
};

function usage(tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }, model: string): Usage {
	const price = PRICES[model];
	if (!price) throw new Error(model);
	const cost = {
		input: (tokens.input * price.input) / 1e6,
		output: (tokens.output * price.output) / 1e6,
		cacheRead: (tokens.cacheRead * price.cacheRead) / 1e6,
		cacheWrite: (tokens.cacheWrite * price.cacheWrite) / 1e6,
	};
	return {
		...tokens,
		totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
		cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite },
	};
}

const T0 = Date.parse("2026-11-26T10:00:00.000Z");
let nextId = 0;

function entry(at: number, body: Record<string, unknown>): SessionEntry {
	nextId += 1;
	return {
		id: `e${nextId}`,
		parentId: nextId > 1 ? `e${nextId - 1}` : null,
		timestamp: new Date(T0 + at).toISOString(),
		...body,
	} as unknown as SessionEntry;
}

function assistant(
	at: number,
	model: string,
	tokens: Parameters<typeof usage>[0],
	toolCalls: Array<Pick<ToolCall, "name" | "arguments">> = [],
): SessionEntry {
	const [provider, id] = model.split("/") as [string, string];
	const message: AssistantMessage = {
		role: "assistant",
		content: toolCalls.length
			? toolCalls.map((call, index) => ({ type: "toolCall" as const, id: `call_${at}_${index}`, ...call }))
			: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider,
		model: id,
		usage: usage(tokens, model),
		stopReason: toolCalls.length ? "toolUse" : "stop",
		timestamp: T0 + at,
	};
	return entry(at, { type: "message", message });
}

function toolResult(at: number, toolName: string): SessionEntry {
	return entry(at, {
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: `call_${at}`,
			toolName,
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: T0 + at,
		},
	});
}

/**
 * A recorded task: a Sonnet call that writes the cache and edits a file, a Sonnet call that reads 200k tokens from the
 * cache and edits two files, a summary sub-task on DeepSeek through OpenRouter, and a compaction. 18m 40s in all.
 */
function recordedTask(): SessionEntry[] {
	nextId = 0;
	return [
		entry(0, {
			type: "message",
			message: { role: "user", content: "Migrate billing to Stripe SDK v2", timestamp: T0 },
		}),
		assistant(5_000, "anthropic/claude-sonnet", { input: 20_000, output: 1_000, cacheRead: 0, cacheWrite: 10_000 }, [
			{ name: "edit", arguments: { path: "src/billing.ts", edits: [] } },
		]),
		toolResult(30_000, "edit"),
		assistant(
			60_000,
			"anthropic/claude-sonnet",
			{ input: 2_000, output: 800, cacheRead: 200_000, cacheWrite: 1_000 },
			[
				{ name: "write", arguments: { path: "src/stripe.ts", content: "x" } },
				{ name: "edit", arguments: { path: "src/billing.ts", edits: [] } },
				{ name: "read", arguments: { path: "src/other.ts" } },
			],
		),
		toolResult(90_000, "write"),
		assistant(600_000, "openrouter/deepseek-chat", { input: 5_000, output: 500, cacheRead: 10_000, cacheWrite: 0 }),
		entry(700_000, {
			type: "compaction",
			summary: "summary",
			firstKeptEntryId: "e1",
			tokensBefore: 100_000,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
			},
		}),
		entry(1_120_000, {
			type: "message",
			message: { role: "user", content: "thanks", timestamp: T0 + 1_120_000 },
		}),
	];
}

/** The ledger of the same task, priced at Sonnet like the terminal app prices it. */
function recordedLedger(): SavingsLedger {
	const ledger = new SavingsLedger({ now: () => T0 });
	ledger.setPricing(() => SONNET);
	ledger.record({ technique: "read_cache", tokens: 3_000, toolCallId: "c1", toolName: "read" });
	ledger.record({ technique: "read_cache", tokens: 1_500, toolCallId: "c2", toolName: "read" });
	ledger.record({ technique: "output_trim", tokens: 12_000, toolCallId: "c3", toolName: "bash" });
	ledger.record({ technique: "diff_edit", tokens: 2_000, toolCallId: "c4", toolName: "edit" });
	ledger.record({ technique: "context_prune", tokens: 40_000, toolCallId: "c5", toolName: "read" });
	ledger.record({ technique: "model_routing", tokens: 0, costUsd: 0.05 });
	return ledger;
}

function recordedInput(overrides: Partial<SavingsReportInput> = {}): SavingsReportInput {
	return {
		entries: recordedTask(),
		ledger: recordedLedger().totals(),
		prices,
		state: "on",
		budget: { spentUsd: 0.208, capUsd: 5 },
		eyesLink: "https://eyes.veyra.localhost/acme/traces/0af7651916cd43dd8448eb211c80319c",
		title: "Stripe SDK v2",
		...overrides,
	};
}

describe("savings ledger pricing and records", () => {
	it("prices a token-only saving at the model in use: input price, output price for a diff edit", () => {
		expect(savingCostUsd("read_cache", 1_000_000, SONNET)).toBe(3);
		expect(savingCostUsd("context_prune", 2_000, SONNET)).toBeCloseTo(0.006, 10);
		expect(savingCostUsd("diff_edit", 1_000_000, SONNET)).toBe(15);
		expect(savingCostUsd("read_cache", 1_000, undefined)).toBeUndefined();
		expect(savingCostUsd("read_cache", 0, SONNET)).toBeUndefined();
		expect(savingCostUsd("read_cache", 1_000, { ...SONNET, inputPerMTok: 0 })).toBeUndefined();

		const ledger = recordedLedger();
		const entries = ledger.entries();
		expect(entries[0]).toEqual({
			technique: "read_cache",
			tokens: 3_000,
			costUsd: 0.009,
			at: T0,
			toolCallId: "c1",
			toolName: "read",
			provider: "anthropic",
			model: "claude-sonnet",
		});
		expect(entries[3]?.costUsd).toBeCloseTo(0.03, 10);
		// Routing reports its own dollars: they are kept, not replaced by a token price.
		expect(entries[5]).toMatchObject({ technique: "model_routing", tokens: 0, costUsd: 0.05 });

		const unpriced = new SavingsLedger();
		unpriced.record({ technique: "read_cache", tokens: 10 });
		expect(unpriced.entries()[0]).toEqual({ technique: "read_cache", tokens: 10, at: expect.any(Number) });
		expect(unpriced.totals().costUsd).toBe(0);
	});

	it("puts no price back only while its source is the current one, and survives a throwing source", () => {
		const ledger = new SavingsLedger();
		const stopFirst = ledger.setPricing(() => SONNET);
		ledger.setPricing(() => ({ ...SONNET, inputPerMTok: 1 }));
		stopFirst();
		ledger.record({ technique: "read_cache", tokens: 1_000_000 });
		expect(ledger.entries()[0]?.costUsd).toBe(1);
		ledger.setPricing(() => {
			throw new Error("no model");
		});
		ledger.record({ technique: "read_cache", tokens: 5 });
		expect(ledger.entries()[1]).toEqual({ technique: "read_cache", tokens: 5, at: expect.any(Number) });
	});

	it("tells record listeners each new entry, loads records back and counts them", () => {
		const ledger = new SavingsLedger({ now: () => 7 });
		const seen: unknown[] = [];
		let changes = 0;
		const stop = ledger.onRecord((record) => seen.push(record));
		ledger.onChange(() => changes++);
		ledger.record({ technique: "output_trim", tokens: 40 });
		ledger.record({ technique: "output_trim", tokens: 0 });
		expect(seen).toEqual([{ technique: "output_trim", tokens: 40, at: 7 }]);
		expect(ledger.size).toBe(1);
		ledger.load([{ technique: "diff_edit", tokens: 3, at: 1 }]);
		expect(seen).toHaveLength(1);
		expect(ledger.totals().byTechnique.diff_edit).toEqual({ tokens: 3, costUsd: 0, count: 1 });
		expect(ledger.totals().byTechnique.output_trim.count).toBe(0);
		expect(changes).toBe(2);
		stop();
		ledger.record({ technique: "output_trim", tokens: 1 });
		expect(seen).toHaveLength(1);
	});

	it("reads back only well-formed records from a session file", () => {
		expect(parseSavingsRecord({ technique: "read_cache", tokens: 12, at: 5, costUsd: 0.1, extra: "x" })).toEqual({
			technique: "read_cache",
			tokens: 12,
			at: 5,
			costUsd: 0.1,
		});
		expect(parseSavingsRecord({ technique: "model_routing", tokens: 0, costUsd: 0.02, at: 1 })).toEqual({
			technique: "model_routing",
			tokens: 0,
			costUsd: 0.02,
			at: 1,
		});
		for (const bad of [
			null,
			"read_cache",
			[],
			{ technique: "nope", tokens: 1 },
			{ technique: "read_cache", tokens: 0 },
			{ technique: "read_cache", tokens: -4 },
			{ technique: "read_cache", tokens: 1.5 },
			{ technique: "read_cache", tokens: 0, costUsd: Number.POSITIVE_INFINITY },
		]) {
			expect(parseSavingsRecord(bad)).toBeUndefined();
		}
		expect(parseSavingsRecord({ technique: "read_cache", tokens: 2, at: -1, toolName: "x".repeat(500) })).toEqual({
			technique: "read_cache",
			tokens: 2,
			at: 0,
		});
	});
});

describe("token-saving report of a recorded task", () => {
	it("matches the report screen", () => {
		const text = savingsReportText(computeSavingsReport(recordedInput()), 120);
		expect(text).toBe(
			[
				"Token saving report  ·  Stripe SDK v2  ·  18m 40s  ·  2 files changed",
				"  Trace sent to Eyes: https://eyes.veyra.localhost/acme/traces/0af7651916cd43dd8448eb211c80319c",
				"",
				"  technique                           tokens saved  cost saved",
				`  ${"─".repeat(96)}`,
				"  Prompt caching (every provider)           210.0k       $0.54   ██████████████████████████",
				"  Cheaper model for sub-tasks                    —       $0.05   ██",
				"  Context pruning before compaction          40.0k       $0.12   ██████",
				"  Tool-output trimming                       12.0k       $0.04   ██",
				"  No duplicate file reads (2 skipped)         4.5k       $0.01   █",
				"  Diff edits instead of rewrites              2.0k       $0.03   █",
				`  ${"─".repeat(96)}`,
				"  Saved                                     268.5k       $0.79   79% less than without these savings",
				"",
				"  Spent      $0.21 of the $5.00 task budget   ·   248.0k tokens in  ·  2.3k out  ·  cache hit 84%",
				"  By provider anthropic $0.19  ·  openrouter $0.004  ·  other $0.01",
				"",
				"  Without sign-in you would have saved only what prompt caching saved (210.0k tokens, $0.54); the other rows are ee token saving.",
			].join("\n"),
		);
	});

	it("adds up to the ledger: the ee rows equal the ledger's totals, Saved equals caching plus the ledger", () => {
		const ledger = recordedLedger();
		const totals = ledger.totals();
		const report = computeSavingsReport(recordedInput({ ledger: totals }));
		const eeRows = report.rows.filter((row) => row.id !== "prompt_caching");
		const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
		expect(sum(eeRows.map((row) => row.tokens))).toBe(totals.tokens);
		expect(sum(eeRows.map((row) => row.costUsd))).toBeCloseTo(totals.costUsd, 12);
		expect(sum(eeRows.map((row) => row.count))).toBe(ledger.entries().length);
		expect(report.tokenSaving).toEqual({ tokens: totals.tokens, costUsd: totals.costUsd, count: 6 });
		// Each row is its technique's sum of entries.
		for (const technique of SAVINGS_TECHNIQUES) {
			const entries = ledger.entries().filter((record) => record.technique === technique);
			const row = report.rows.find((candidate) => candidate.id === technique);
			expect(row?.tokens ?? 0).toBe(sum(entries.map((record) => record.tokens)));
			expect(row?.costUsd ?? 0).toBeCloseTo(sum(entries.map((record) => record.costUsd ?? 0)), 12);
		}
		expect(report.savedTokens).toBe(report.caching.tokens + totals.tokens);
		expect(report.savedUsd).toBeCloseTo(report.caching.costUsd + totals.costUsd, 12);
		expect(totals.tokens).toBe(58_500);
		expect(totals.costUsd).toBeCloseTo(0.2495, 12);
	});

	it("prices prompt caching from the reported usage: reads at the input price, less read cost and write premium", () => {
		const report = computeSavingsReport(recordedInput());
		// Sonnet call 1: writes 10k (premium 0.0375 - 0.03); call 2: reads 200k (0.6 - 0.06), writes 1k (0.00375 -
		// 0.003); DeepSeek: reads 10k (0.005 - 0.0005).
		expect(report.caching.tokens).toBe(210_000);
		expect(report.caching.costUsd).toBeCloseTo(-0.0075 + 0.54 - 0.00075 + 0.0045, 12);
		expect(report.spentUsd).toBeCloseTo(0.1125 + 0.08175 + 0.00375 + 0.01, 12);
		expect(report.tokensIn).toBe(27_000 + 210_000 + 11_000);
		expect(report.tokensOut).toBe(2_300);
		expect(report.byProvider.map((entry) => entry.provider)).toEqual(["anthropic", "openrouter", "other"]);
		expect(report.filesChanged).toBe(2);
		expect(report.durationMs).toBe(1_120_000);

		// An unpriced model saves tokens only.
		const unpriced = computeSavingsReport(recordedInput({ prices: { getModel: () => undefined } }));
		expect(unpriced.caching).toEqual({ tokens: 210_000, costUsd: 0 });
	});

	it("says what sign-in would change, and shows only what saved something", () => {
		const signedOut = computeSavingsReport(
			recordedInput({
				ledger: new SavingsLedger().totals(),
				state: "signed_out",
				budget: undefined,
				eyesLink: undefined,
			}),
		);
		expect(signedOut.rows.map((row) => row.id)).toEqual(["prompt_caching"]);
		const text = savingsReportText(signedOut);
		expect(text).not.toContain("Trace sent to Eyes");
		expect(text).toContain("  Spent      $0.21   ·   248.0k tokens in");
		expect(text.split("\n").at(-1)).toBe(
			"  Core only: prompt caching is on. fingers login turns on token saving when your organization’s Veyra tier includes it.",
		);
		expect(withoutSignInText({ ...signedOut, state: "off" })).toBe(
			"Token saving is off for this sign-in (not in your organization’s tier, or Fingers is off), so only prompt caching saved.",
		);

		const empty = computeSavingsReport({
			entries: [],
			ledger: new SavingsLedger().totals(),
			prices,
			state: "signed_out",
		});
		expect(savingsReportText(empty)).toContain("  Nothing saved yet in this conversation.");
		expect(empty.lessPercent).toBeUndefined();
	});

	it("draws in the terminal at any width without passing it", () => {
		initTheme("dark");
		const component = new SavingsReportComponent(computeSavingsReport(recordedInput()));
		for (const width of [40, 80, 120]) {
			const lines = component.render(width);
			expect(lines.length).toBeGreaterThan(10);
			for (const line of lines) {
				expect([...line.replace(/\u001b\[[0-9;]*m/g, "")].length).toBeLessThanOrEqual(width);
			}
		}
	});

	it("says what one run saved", () => {
		expect(runSavingsLine({ tokens: 12_300, costUsd: 0.04 })).toBe(
			"Token saving: 12.3k tokens ($0.04) saved in this run. /savings shows the report.",
		);
		expect(runSavingsLine({ tokens: 0, costUsd: 0.05 })).toBe(
			"Token saving: $0.05 saved in this run. /savings shows the report.",
		);
		expect(runSavingsLine({ tokens: 0, costUsd: 0 })).toBeUndefined();
	});

	it("takes the Eyes link from the live exporter that has one", () => {
		const exporters = new TelemetryExporters();
		exporters.set("otlp", { export: () => {} });
		expect(exporters.lastTraceLink()).toBeUndefined();
		let on = true;
		exporters.set("ee", { export: () => {}, lastTraceLink: () => "https://eyes.example/acme/traces/1" }, () => on);
		expect(exporters.lastTraceLink()).toBe("https://eyes.example/acme/traces/1");
		on = false;
		expect(exporters.lastTraceLink()).toBeUndefined();
		exporters.set(
			"ee",
			{
				export: () => {},
				lastTraceLink: () => {
					throw new Error("broken");
				},
			},
			() => true,
		);
		expect(exporters.lastTraceLink()).toBeUndefined();
	});
});

describe("the edition extension keeps the conversation's savings", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const echoTool: AgentTool = {
		name: "echo",
		label: "echo",
		description: "Echoes.",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "a long output" }], details: undefined }),
	};

	/** Token saving stand-in: every echo result saves 4,000 tokens, written to the ledger as ee would. */
	function savingHooks(ledger: SavingsLedger): EditionToolHooks {
		const hooks = new EditionToolHooks();
		hooks.set(
			[
				{
					feature: "token_saving",
					hooks: {
						toolResult: (result) => {
							ledger.record({
								technique: "output_trim",
								tokens: 4_000,
								toolCallId: result.toolCallId,
								toolName: result.toolName,
							});
							return undefined;
						},
					},
				},
			],
			() => true,
		);
		return hooks;
	}

	async function harnessWith(ledger: SavingsLedger, sessionManager?: SessionManager) {
		const harness = await createHarness({
			models: [{ id: "priced", cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } }],
			tools: [echoTool],
			sessionManager,
			extensionFactories: [
				{ name: "edition", factory: createEditionExtension({ hooks: savingHooks(ledger), savings: ledger }) },
			],
		});
		harnesses.push(harness);
		return harness;
	}

	function savedRecords(manager: SessionManager) {
		return manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === SAVINGS_ENTRY_TYPE);
	}

	it("prices savings at the model in use, writes them to the session file when the run settles, says what the run saved", async () => {
		const ledger = new SavingsLedger();
		const harness = await harnessWith(ledger);
		const notices: string[] = [];
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({ notify: (message) => notices.push(message) }),
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("echo", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");

		expect(ledger.totals().byTechnique.output_trim).toEqual({ tokens: 8_000, costUsd: 0.016, count: 2 });
		expect(ledger.entries()[0]).toMatchObject({ provider: harness.getModel().provider, model: "priced" });
		const saved = savedRecords(harness.sessionManager);
		expect(saved).toHaveLength(2);
		expect(saved.map((entry) => (entry as { data: unknown }).data)).toEqual(ledger.entries());
		expect(notices).toEqual(["Token saving: 8.0k tokens ($0.02) saved in this run. /savings shows the report."]);

		// The next run saved nothing: no line, nothing more written.
		harness.setResponses([fauxAssistantMessage("again")]);
		await harness.session.prompt("again");
		expect(notices).toHaveLength(1);
		expect(savedRecords(harness.sessionManager)).toHaveLength(2);
	});

	it("reads the savings back when the conversation is opened again, and starts a new one from zero", async () => {
		const ledger = new SavingsLedger();
		const manager = SessionManager.inMemory();
		const first = await harnessWith(ledger, manager);
		first.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await first.session.prompt("go");
		const recorded = ledger.entries();
		expect(recorded).toHaveLength(1);
		expect(savingsOnBranch(manager.getBranch())).toEqual(recorded);

		// Another process opens the same conversation: its ledger comes from the session file.
		const resumedLedger = new SavingsLedger();
		const resumed = await harnessWith(resumedLedger, manager);
		await resumed.session.bindExtensions({});
		expect(resumedLedger.entries()).toEqual(recorded);
		expect(resumedLedger.totals().byTechnique.output_trim.costUsd).toBeCloseTo(0.008, 12);

		// A reload keeps them (written at shutdown, read back at start), also a saving not yet written.
		resumedLedger.record({ technique: "read_cache", tokens: 100 });
		await resumed.session.reload();
		expect(resumedLedger.entries().map((record) => record.technique)).toEqual(["output_trim", "read_cache"]);
		expect(savedRecords(manager)).toHaveLength(2);

		// A new conversation starts from zero.
		const fresh = await harnessWith(resumedLedger, SessionManager.inMemory());
		await fresh.session.bindExtensions({});
		expect(resumedLedger.entries()).toEqual([]);
	});

	it("shows each branch of the conversation its own savings after a move in /tree", async () => {
		const ledger = new SavingsLedger();
		const harness = await harnessWith(ledger);
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("hi")]);
		await harness.session.prompt("hello");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(ledger.size).toBe(1);
		const entries = harness.sessionManager.getEntries();
		const savedLeaf = entries.at(-1);
		expect(savedLeaf).toMatchObject({ type: "custom", customType: SAVINGS_ENTRY_TYPE });
		const secondPrompt = entries.findLast(
			(candidate) => candidate.type === "message" && candidate.message.role === "user",
		);

		// Back to before the second prompt: that branch saved nothing.
		await harness.session.navigateTree(secondPrompt!.id, { summarize: false });
		expect(ledger.entries()).toEqual([]);
		// And forward again: its saving is back.
		await harness.session.navigateTree(savedLeaf!.id, { summarize: false });
		expect(ledger.totals().byTechnique.output_trim).toMatchObject({ tokens: 4_000, count: 1 });
	});

	it("has no price for an unpriced model", () => {
		expect(savingsPricing(undefined)).toBeUndefined();
		expect(
			savingsPricing({
				provider: "local",
				id: "llama",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			} as never),
		).toBeUndefined();
		expect(
			savingsPricing({
				provider: "a",
				id: "m",
				cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
			} as never),
		).toEqual({ provider: "a", model: "m", inputPerMTok: 1, outputPerMTok: 5 });
	});
});

describe("/savings in the terminal app", () => {
	type SavingsThis = {
		editionGate?: { state: (feature: string) => { on: boolean; reason?: string } };
		veyraAccount?: unknown;
		sessionManager: SessionManager;
		session: { modelRuntime: SavingsPriceSource };
		budgetGuard: { state: () => { spentUsd: number; capUsd: number } | undefined };
		chatContainer: { addChild: (component: unknown) => void };
		ui: { requestRender: () => void };
	};
	const handleSavingsCommand = Reflect.get(InteractiveMode.prototype, "handleSavingsCommand") as (
		this: SavingsThis,
	) => void;

	function mode(overrides: Partial<SavingsThis> = {}) {
		const manager = SessionManager.inMemory();
		for (const recorded of recordedTask()) {
			if (recorded.type === "message")
				manager.appendMessage(recorded.message as Parameters<SessionManager["appendMessage"]>[0]);
		}
		const children: unknown[] = [];
		const self: SavingsThis = {
			sessionManager: manager,
			session: { modelRuntime: prices },
			budgetGuard: { state: () => ({ spentUsd: 0.2, capUsd: 5 }) },
			chatContainer: { addChild: (component) => children.push(component) },
			ui: { requestRender: () => {} },
			...overrides,
		};
		const report = () => {
			const component = children.at(-1);
			expect(component).toBeInstanceOf(SavingsReportComponent);
			return (component as SavingsReportComponent).render(160).map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
		};
		return { self, report };
	}

	afterEach(() => savingsLedger.clear());

	it("is a core command and shows this conversation's report", () => {
		initTheme("dark");
		const command = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === "savings");
		expect(command).toBeDefined();
		expect(command?.edition).toBeUndefined();

		const { self, report } = mode();
		handleSavingsCommand.call(self);
		const lines = report();
		expect(lines.some((line) => line.includes("Prompt caching (every provider)") && line.includes("210.0k"))).toBe(
			true,
		);
		expect(lines.some((line) => line.includes("of the $5.00 task budget"))).toBe(true);
		expect(lines.at(-1)).toContain("Core only: prompt caching is on.");
	});

	it("adds the ledger's rows and says what sign-in adds while token saving is on", () => {
		savingsLedger.load(recordedLedger().entries());
		const { self, report } = mode({
			veyraAccount: { email: "a@acme.test" },
			editionGate: { state: (feature) => ({ on: feature === "token_saving" }) },
		});
		handleSavingsCommand.call(self);
		const lines = report();
		expect(lines.some((line) => line.includes("No duplicate file reads (2 skipped)"))).toBe(true);
		expect(lines.at(-1)).toContain("Without sign-in you would have saved only what prompt caching saved");

		const off = mode({
			veyraAccount: { email: "a@acme.test" },
			editionGate: { state: () => ({ on: false, reason: "tier" }) },
		});
		handleSavingsCommand.call(off.self);
		expect(off.report().at(-1)).toContain("Token saving is off for this sign-in");
	});
});
