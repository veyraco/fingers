// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * Saving context (F15): staged pruning of old tool results before the core's compaction, and the saving estimate of
 * a compaction. Unit tests of the plan and the estimate, then long sessions through the core's real gate, the
 * built-in `edition` extension, the real read tool and a fake model whose usage counts what it was sent.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@veyraco/fingers-agent";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, type Usage } from "@veyraco/fingers-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	EditionGate,
	EditionToolHooks,
	type EeCompactionOutcome,
	type EeCompactionPreview,
	type EeContextEntry,
	type EeContextView,
	type EeEntitlement,
} from "../../packages/coding-agent/src/core/edition/index.ts";
import { SavingsLedger } from "../../packages/coding-agent/src/core/savings-ledger.ts";
import { createReadTool } from "../../packages/coding-agent/src/core/tools/read.ts";
import { createEditionExtension } from "../../packages/coding-agent/src/extensions/edition/index.ts";
import { createHarness, createTestUiContext, type Harness } from "../../packages/coding-agent/test/suite/harness.ts";
import * as ee from "../src/index.ts";
import {
	compactionLimit,
	estimateCompactionSaving,
	expectedSummaryTokens,
	minimumBatchTokens,
	PRUNE_KEEP_LAST_RESULTS,
	PRUNE_REWRITE_FACTOR,
	planPrune,
	prunedNote,
} from "../src/token-saving/context.ts";
import { TokenSaving } from "../src/token-saving/index.ts";

const LOW: EeEntitlement = {
	signedIn: true,
	source: "connect",
	org: "org_acme",
	orgName: "Acme",
	tier: "low",
	fingersEnabled: true,
};

const COMPACTION = { enabled: true, reserveTokens: 4000, keepRecentTokens: 8000 };

function result(id: string, tokens: number, overrides: Partial<EeContextEntry> = {}): EeContextEntry {
	return {
		id,
		role: "toolResult",
		tokens,
		edited: false,
		toolName: "read",
		toolCallId: `call_${id}`,
		isError: false,
		input: { path: `src/${id}.ts` },
		path: `/work/src/${id}.ts`,
		content: [{ type: "text", text: "x".repeat(tokens * 4) }],
		...overrides,
	};
}

function turn(id: string, tokens = 20): EeContextEntry {
	return { id, role: "assistant", tokens, edited: false };
}

function view(entries: EeContextEntry[], tokens: number, contextWindow = 40_000): EeContextView {
	return { entries, tokens, contextWindow, compaction: COMPACTION, cwd: "/work" };
}

/** user, then `count` pairs of an assistant tool call and a read result of `size` tokens. */
function conversation(count: number, size: number): EeContextEntry[] {
	const entries: EeContextEntry[] = [{ id: "u0", role: "user", tokens: 30, edited: false }];
	for (let index = 0; index < count; index++) entries.push(turn(`a${index}`), result(`r${index}`, size));
	return entries;
}

describe("staged pruning plan", () => {
	// Window 40,000, reserve 4,000: the core compacts above 36,000. Stage 1 from 18,000 keeps the newest 8,000 tokens
	// (min of keepRecentTokens and 40% of 36,000), stage 2 from 27,000 keeps the newest 4,000.
	it("prunes nothing below half of the compaction limit", () => {
		expect(compactionLimit(view([], 0))).toBe(36_000);
		expect(planPrune(view(conversation(13, 2000), 17_999))).toEqual([]);
	});

	it("stage 1 prunes the results older than the newest 8,000 tokens, oldest first, as notes", () => {
		const entries = conversation(13, 2000);
		const plan = planPrune(view(entries, 26_300));
		// Newest first: r12 a12 r11 a11 r10 a10 r9 a9 are 8,080 tokens; r9 crosses 8,000 and is kept with the newer ones.
		expect(plan.map(({ edit }) => edit.targetId)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"]);
		const note = prunedNote(entries[2] as EeContextEntry, "/work");
		expect(note).toBe(
			"[pruned by token saving] This earlier read result of src/r0.ts (1 line, about 2000 tokens) was taken out of the context to save tokens. Run the tool again if you still need it.",
		);
		expect(plan[0]?.edit.content).toEqual([{ type: "text", text: note }]);
		expect(plan[0]?.savedTokens).toBe(2000 - Math.ceil(note.length / 4));
	});

	it("stage 1 waits until a batch frees twice what the provider caches again after it; stage 2 does not", () => {
		// Nine results: r0..r4 would free about 9,800 tokens, and about 8,400 after r0 would be cached again.
		expect(PRUNE_REWRITE_FACTOR).toBe(2);
		expect(planPrune(view(conversation(9, 2000), 18_300))).toEqual([]);
		// Stage 2 keeps the newest 4,000 tokens: r8 a8 r7 (r7 crosses), so r0..r6 go.
		const plan = planPrune(view(conversation(9, 2000), 27_500));
		expect(plan.map(({ edit }) => edit.targetId)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5", "r6"]);
		// 1,000-token results: the newest 4,000 tokens reach back to r8 (which crosses), so r0..r7 go.
		const small = planPrune(view(conversation(12, 1000), 27_500));
		expect(small.map(({ edit }) => edit.targetId)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
	});

	it("skips edited, small, recent and non-result entries, and a batch that frees too little", () => {
		const entries = conversation(9, 2000);
		entries[2] = { ...(entries[2] as EeContextEntry), edited: true };
		entries[4] = { ...(entries[4] as EeContextEntry), tokens: 199 };
		const plan = planPrune(view(entries, 27_500));
		expect(plan.map(({ edit }) => edit.targetId)).toEqual(["r2", "r3", "r4", "r5", "r6"]);
		// Only one old result of 1,000 tokens: below the 1,800-token minimum batch (5% of 36,000).
		expect(minimumBatchTokens(36_000)).toBe(1800);
		const tooLittle = [
			{ id: "u0", role: "user" as const, tokens: 30, edited: false },
			result("old", 1000),
			turn("a", 9000),
			result("x", 250),
			result("y", 250),
		];
		expect(planPrune(view(tooLittle, 27_500))).toEqual([]);
	});

	it("never prunes the last two tool results, however large the recent part is", () => {
		const entries = [{ id: "u0", role: "user" as const, tokens: 30, edited: false }, result("r0", 12_000)];
		entries.push(result("r1", 12_000), result("r2", 12_000));
		expect(PRUNE_KEEP_LAST_RESULTS).toBe(2);
		// Window 80,000: limit 76,000, stage 2 from 57,000 keeps the newest 4,000 tokens; r1 and r2 are 24,000.
		const plan = planPrune(view(entries, 58_000, 80_000));
		expect(plan.map(({ edit }) => edit.targetId)).toEqual(["r0"]);
	});

	it("names a shell command and an error in the note, and counts images", () => {
		const shell = result("s", 500, {
			toolName: "bash",
			path: undefined,
			input: { command: "npm   run\n build" },
			isError: true,
			content: [
				{ type: "text", text: "a\nb\nc" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
		});
		expect(prunedNote(shell, "/work")).toBe(
			"[pruned by token saving] This earlier bash error of `npm run build` (3 lines, 1 image, about 500 tokens) was taken out of the context to save tokens. Run the tool again if you still need it.",
		);
	});
});

describe("compaction estimate", () => {
	const preview: EeCompactionPreview = {
		reason: "manual",
		tokensBefore: 30_000,
		summarizedTokens: 20_000,
		previousSummaryTokens: 0,
		fileListTokens: 40,
		splitTurn: false,
		summaryMaxTokens: 3200,
	};

	it("is the summarised messages and the earlier summary minus the expected summary", () => {
		// 4% of 20,000 = 800, plus the file lists.
		expect(expectedSummaryTokens(preview)).toBe(840);
		expect(estimateCompactionSaving(preview)).toBe(20_000 - 840);
		// An update keeps about the earlier summary's size; a split turn adds a second, smaller summary.
		expect(expectedSummaryTokens({ ...preview, previousSummaryTokens: 1500 })).toBe(1500);
		expect(estimateCompactionSaving({ ...preview, previousSummaryTokens: 1500 })).toBe(20_000);
		expect(expectedSummaryTokens({ ...preview, splitTurn: true })).toBe(1240);
		// Never more than the summary call may write, never less than 300.
		expect(expectedSummaryTokens({ ...preview, summarizedTokens: 1_000_000 })).toBe(3240);
		expect(expectedSummaryTokens({ ...preview, summarizedTokens: 100 })).toBe(340);
	});

	it("says what it should save before and what it saved after", () => {
		const saving = new TokenSaving();
		expect(saving.hooks.beforeCompact?.(preview)).toBe(
			"Token saving: this compaction should save about 19,160 tokens (30,000 → about 10,840).",
		);
		const outcome: EeCompactionOutcome = {
			reason: "manual",
			tokensBefore: 30_000,
			tokensAfter: 10_500,
			summaryTokens: 900,
		};
		expect(saving.hooks.afterCompact?.(outcome)).toBe(
			"Token saving: compaction saved 19,500 tokens (30,000 → 10,500); the estimate was 19,160.",
		);
		expect(saving.hooks.afterCompact?.(outcome)).toBe(
			"Token saving: compaction saved 19,500 tokens (30,000 → 10,500).",
		);
	});
});

// ----------------------------------------------------------------------------
// Long sessions
// ----------------------------------------------------------------------------

/** A file of about 2,000 tokens with its own text, so the read cache never serves it. */
function fileText(index: number): string {
	return Array.from({ length: 100 }, (_, line) =>
		`file ${index} line ${line}: ${"lorem ipsum dolor sit amet ".repeat(2)}`.slice(0, 79),
	).join("\n");
}

/** About 1,000 tokens, like a structured summary. */
const SUMMARY = `## Goal\nRead the project files.\n\n## Progress\n${"- read a file and noted its contents\n".repeat(108)}`;

/** About 300 tokens, for the first part of a split turn. */
const TURN_SUMMARY = `## Original Request\nRead the next two files.\n\n## Progress So Far\n${"- read one of the two files\n".repeat(40)}`;

function summaryReply(context: { messages: unknown[] }): AssistantMessage | undefined {
	const text = JSON.stringify(context.messages);
	if (text.includes("Create a concise checkpoint")) return fauxAssistantMessage(TURN_SUMMARY);
	if (text.includes("context summarization assistant") || text.includes("<conversation>")) {
		return fauxAssistantMessage(SUMMARY);
	}
	return undefined;
}

function promptTokens(usage: Usage | undefined): number {
	return usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
}

interface Run {
	harness: Harness;
	savings: SavingsLedger;
	hooks: EditionToolHooks;
	files: string[];
	previews: EeCompactionPreview[];
	outcomes: EeCompactionOutcome[];
	notices: string[];
	/** The messages of each request of the conversation (summary requests not included). */
	requests: string[];
}

const harnesses: Harness[] = [];
afterEach(() => {
	ee.tokenSaving.reset();
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function run(
	entitlement: EeEntitlement | undefined,
	keepRecentTokens = COMPACTION.keepRecentTokens,
): Promise<Run> {
	const hooks = new EditionToolHooks();
	const savings = new SavingsLedger();
	if (entitlement) {
		const gate = new EditionGate({ loadModule: async () => ee, toolHooks: hooks, savings });
		await gate.setEntitlement(entitlement);
	}
	const previews: EeCompactionPreview[] = [];
	const outcomes: EeCompactionOutcome[] = [];
	const before = hooks.beforeCompact.bind(hooks);
	hooks.beforeCompact = (preview) => {
		previews.push(preview);
		return before(preview);
	};
	const after = hooks.afterCompact.bind(hooks);
	hooks.afterCompact = (outcome) => {
		outcomes.push(outcome);
		return after(outcome);
	};
	const harness = await createHarness({
		models: [{ id: "faux-40k", contextWindow: 40_000 }],
		settings: { compaction: { ...COMPACTION, keepRecentTokens } },
		tools: [createReadTool(process.cwd())],
		extensionFactories: [{ name: "edition", factory: createEditionExtension({ hooks, savings }) }],
	});
	harnesses.push(harness);
	// A session id turns on the fake provider's prompt cache: a request reads the prefix it shares with the one before.
	harness.session.agent.sessionId = "long-session";
	const notices: string[] = [];
	await harness.session.bindExtensions({
		mode: "tui",
		uiContext: createTestUiContext({ notify: (message) => notices.push(message) }),
	});
	const files = Array.from({ length: 40 }, (_, index) => {
		const file = join(harness.tempDir, `file-${index}.txt`);
		writeFileSync(file, fileText(index));
		return file;
	});
	let next = 0;
	const requests: string[] = [];
	const respond = (context: { messages: unknown[] }) => {
		const summary = summaryReply(context);
		if (summary) return summary;
		requests.push(JSON.stringify(context.messages));
		const messages = context.messages as AgentMessage[];
		const lastUser = messages.findLastIndex((message) => message.role === "user");
		const reads = messages.slice(lastUser + 1).filter((message) => message.role === "toolResult").length;
		if (reads < 2)
			return fauxAssistantMessage([fauxToolCall("read", { path: files[next++] })], { stopReason: "toolUse" });
		return fauxAssistantMessage("Read both files.");
	};
	harness.setResponses(Array.from({ length: 400 }, () => respond));
	return { harness, savings, hooks, files, previews, outcomes, notices, requests };
}

/** What the model was sent over the whole session: every request, summaries included. */
function spent(harness: Harness) {
	let total = 0;
	let billed = 0;
	let largest = 0;
	let compactions = 0;
	for (const entry of harness.sessionManager.getEntries()) {
		let usage: Usage | undefined;
		if (entry.type === "message" && entry.message.role === "assistant") {
			usage = (entry.message as AssistantMessage).usage;
			largest = Math.max(largest, promptTokens(usage));
		} else if (entry.type === "compaction") {
			compactions++;
			usage = entry.usage;
		}
		if (!usage) continue;
		total += promptTokens(usage);
		// Anthropic-like prices relative to a fresh input token: a cache write 1.25, a cache read 0.1.
		billed += usage.input + 1.25 * usage.cacheWrite + 0.1 * usage.cacheRead;
	}
	return { total, billed, largest, compactions };
}

async function talk(harness: Harness, prompts: number): Promise<void> {
	for (let index = 0; index < prompts; index++) await harness.session.prompt(`read the next two files (${index})`);
}

describe("saving context in a long session (real gate, edition extension and read tool)", () => {
	// 15 prompts of two 2,000-token reads each, 60,000 tokens of results in a 40,000-token window. keepRecentTokens
	// 8,000 is a large recent part (22% of the limit); 4,000 is the default's share (20,000 of 183,616 for 200,000).
	it.each([8000, 4000])(
		"stays under the context limit with fewer tokens than core compaction alone (keepRecentTokens %i)",
		async (keepRecentTokens) => {
			const core = await run(undefined, keepRecentTokens);
			await talk(core.harness, 15);
			const saving = await run(LOW, keepRecentTokens);
			await talk(saving.harness, 15);

			const coreSpent = spent(core.harness);
			const eeSpent = spent(saving.harness);
			// Both stay under the window; core compaction alone needs a compaction and sends more, also as billed.
			expect(coreSpent.largest).toBeLessThan(40_000);
			expect(eeSpent.largest).toBeLessThan(40_000);
			expect(coreSpent.compactions).toBeGreaterThan(0);
			expect(eeSpent.compactions).toBeLessThan(coreSpent.compactions);
			expect(eeSpent.total).toBeLessThan(0.85 * coreSpent.total);
			expect(eeSpent.billed).toBeLessThan(0.9 * coreSpent.billed);
			// Every pruned result is a context edit in the session and a ledger entry; core only has none.
			const edits = saving.harness.sessionManager.getEntries().filter((entry) => entry.type === "context_edit");
			expect(edits.length).toBeGreaterThan(0);
			expect(saving.savings.totals().byTechnique.context_prune.count).toBe(edits.length);
			expect(core.harness.sessionManager.getEntries().some((entry) => entry.type === "context_edit")).toBe(false);
			expect(core.savings.totals().tokens).toBe(0);
			expect(core.previews).toEqual([]);
		},
	);

	it("prunes with a note the model gets instead of the old result, and a pruned file reads fresh", async () => {
		const saving = await run(LOW);
		const requests = saving.requests;
		await talk(saving.harness, 8);
		const firstFile = saving.files[0] as string;
		const pruned = requests.findIndex((request) => request.includes("[pruned by token saving]"));
		expect(pruned).toBeGreaterThan(0);
		// Before the prune the model had file 0's text; from the prune on it has the note instead.
		expect(requests[pruned - 1]).toContain("file 0 line 7:");
		expect(requests[pruned]).not.toContain("file 0 line 7:");
		expect(requests[pruned]).toContain(`read result of ${firstFile.slice(saving.harness.tempDir.length + 1)}`);
		// The note stays: every later request has it, and none has the old text back.
		for (const request of requests.slice(pruned)) expect(request).not.toContain("file 0 line 7:");
		// Read the pruned file again: its text comes back (the read cache forgot it), not a "from cache" note.
		const recorded = (reply: AssistantMessage) => (context: { messages: unknown[] }) => {
			requests.push(JSON.stringify(context.messages));
			return reply;
		};
		saving.harness.setResponses([
			recorded(fauxAssistantMessage([fauxToolCall("read", { path: firstFile })], { stopReason: "toolUse" })),
			recorded(fauxAssistantMessage("done")),
		]);
		await saving.harness.session.prompt("read the first file again");
		const messages = JSON.parse(requests.at(-1) ?? "[]") as { role: string; content: { text?: string }[] }[];
		const reread = messages.findLast((message) => message.role === "toolResult");
		expect(reread?.content.map((block) => block.text ?? "").join("")).toBe(fileText(0));
	});

	it("estimates each compaction within 15% of what it saved, and says so before and after", async () => {
		const saving = await run(LOW);
		await talk(saving.harness, 6);
		const measured: { estimate: number; saved: number }[] = [];
		for (const keepRecentTokens of [3000, 6000, 1]) {
			saving.harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens } });
			await saving.harness.session.compact();
			const preview = saving.previews.at(-1) as EeCompactionPreview;
			const outcome = saving.outcomes.at(-1) as EeCompactionOutcome;
			measured.push({
				estimate: estimateCompactionSaving(preview),
				saved: outcome.tokensBefore - outcome.tokensAfter,
			});
			await talk(saving.harness, 3);
		}
		expect(saving.previews).toHaveLength(3);
		// A split turn and an update of an earlier summary are among them.
		expect(saving.previews.some((preview) => preview.splitTurn)).toBe(true);
		expect(saving.previews.at(-1)?.previousSummaryTokens).toBeGreaterThan(0);
		for (const { estimate, saved } of measured) {
			expect(saved).toBeGreaterThan(0);
			expect(Math.abs(estimate - saved)).toBeLessThanOrEqual(0.15 * saved);
		}
		// Shown while it runs, and kept for the terminal app to show under the redrawn chat.
		expect(
			saving.notices.filter((line) => line.startsWith("Token saving: this compaction should save about")),
		).toHaveLength(3);
		const after = saving.hooks.takeNotices();
		expect(after).toHaveLength(3);
		expect(after[0]).toMatch(
			/^Token saving: compaction saved [\d,]+ tokens \([\d,]+ → [\d,]+\); the estimate was [\d,]+\.$/,
		);
		expect(saving.hooks.takeNotices()).toEqual([]);
	});

	it("shows no compaction line without token saving", async () => {
		const core = await run(undefined);
		await talk(core.harness, 3);
		core.harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		await core.harness.session.compact();
		expect(core.previews).toEqual([]);
		expect(core.notices).toEqual([]);
		expect(core.hooks.takeNotices()).toEqual([]);
	});
});
