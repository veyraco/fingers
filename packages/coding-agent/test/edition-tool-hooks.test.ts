/**
 * Open core: ee features act on a session only through the tool hooks the gate hands the built-in `edition`
 * extension, and only while the feature is on. These tests use stand-in ee modules, so they pass without ee/.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@veyraco/fingers-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	EditionGate,
	EditionToolHooks,
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
import { createHarness, type Harness } from "./suite/harness.ts";

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
		apiVersion: 2,
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
		expect(savings.totals().byTechnique.read_cache).toEqual({ tokens: 10, count: 1 });
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

describe("SavingsLedger", () => {
	it("adds up entries per technique and ignores entries that save nothing", () => {
		const ledger = new SavingsLedger({ now: () => 5 });
		ledger.record({ technique: "read_cache", tokens: 120.7, toolCallId: "c1", toolName: "read" });
		ledger.record({ technique: "output_trim", tokens: 30 });
		ledger.record({ technique: "read_cache", tokens: 5 });
		ledger.record({ technique: "diff_edit", tokens: 0 });
		ledger.record({ technique: "diff_edit", tokens: Number.NaN });
		ledger.record({ technique: "nonsense" as never, tokens: 50 });
		expect(ledger.totals()).toEqual({
			byTechnique: {
				read_cache: { tokens: 125, count: 2 },
				output_trim: { tokens: 30, count: 1 },
				diff_edit: { tokens: 0, count: 0 },
			},
			tokens: 155,
		});
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
			tools: [createReadTool(process.cwd())],
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
