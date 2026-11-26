// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * Token saving, part 1 (F14): no duplicate reads, trimmed tool outputs, diff edits, each written to the savings
 * ledger. Unit tests of each technique, then whole sessions through the core's real gate, the built-in `edition`
 * extension, the real read tool and a fake model that records what it was sent.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@veyraco/fingers-agent";
import { fauxAssistantMessage, fauxToolCall } from "@veyraco/fingers-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	EditionGate,
	EditionToolHooks,
	type EeEntitlement,
	type EeToolResult,
} from "../../packages/coding-agent/src/core/edition/index.ts";
import { SavingsLedger } from "../../packages/coding-agent/src/core/savings-ledger.ts";
import { createReadTool } from "../../packages/coding-agent/src/core/tools/read.ts";
import { createEditionExtension } from "../../packages/coding-agent/src/extensions/edition/index.ts";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.ts";
import * as ee from "../src/index.ts";
import { diffEditSaving } from "../src/token-saving/diff-edit.ts";
import { TokenSaving } from "../src/token-saving/index.ts";
import { ReadCache, readCacheNote } from "../src/token-saving/read-cache.ts";
import { isErrorLine, TAIL_LINES, TRIM_MIN_LINES, trimToolOutput } from "../src/token-saving/trim.ts";

const BODY = Array.from({ length: 40 }, (_, index) => `line ${index + 1} of the notes, with enough text to count`).join(
	"\n",
);

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fingers-ee-ts-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function readResult(path: string, text: string, overrides: Partial<EeToolResult> = {}): EeToolResult {
	return {
		toolName: "read",
		toolCallId: "call_read",
		nested: false,
		input: { path },
		content: [{ type: "text", text }],
		isError: false,
		cwd: dir,
		path,
		...overrides,
	};
}

function text(change: { content: EeToolResult["content"] } | undefined): string | undefined {
	const block = change?.content[0];
	return block?.type === "text" ? block.text : undefined;
}

describe("read cache", () => {
	it("serves a second read of an unchanged file as a note, and a changed file is read again", async () => {
		const file = join(dir, "notes.txt");
		writeFileSync(file, BODY);
		const cache = new ReadCache();
		expect(await cache.onRead(readResult(file, BODY))).toBeUndefined();
		const hit = await cache.onRead(readResult(file, BODY, { toolCallId: "call_2" }));
		expect(text(hit?.change)).toBe(readCacheNote(file));
		expect(hit?.savedTokens).toBe(Math.ceil(BODY.length / 4) - Math.ceil(readCacheNote(file).length / 4));

		writeFileSync(file, `${BODY}\nnew line`);
		expect(await cache.onRead(readResult(file, `${BODY}\nnew line`))).toBeUndefined();
	});

	it("re-reads a same-size change even when the mtime was put back (the text's hash)", async () => {
		const file = join(dir, "notes.txt");
		writeFileSync(file, BODY);
		const cache = new ReadCache();
		// A whole-millisecond mtime, so putting it back makes it identical.
		const mtime = new Date(Math.floor(statSync(file).mtimeMs) - 10_000);
		utimesSync(file, mtime, mtime);
		await cache.onRead(readResult(file, BODY));
		const swapped = BODY.replace("line 1 of", "LINE 1 of");
		writeFileSync(file, swapped);
		utimesSync(file, mtime, mtime);
		expect(statSync(file).mtimeMs).toBe(mtime.getTime());
		expect(await cache.onRead(readResult(file, swapped))).toBeUndefined();
	});

	it("re-reads when only the mtime changed, when the range differs, and sends the body after one note", async () => {
		const file = join(dir, "notes.txt");
		writeFileSync(file, BODY);
		const cache = new ReadCache();
		await cache.onRead(readResult(file, BODY));
		const later = new Date(statSync(file).mtimeMs + 5000);
		utimesSync(file, later, later);
		expect(await cache.onRead(readResult(file, BODY))).toBeUndefined();
		expect(await cache.onRead(readResult(file, BODY))).toBeDefined();
		// After a note, reading once more gets the text, then the next read is a note again.
		expect(await cache.onRead(readResult(file, BODY))).toBeUndefined();
		expect(await cache.onRead(readResult(file, BODY))).toBeDefined();
		// Another range of the same file is another read.
		expect(await cache.onRead(readResult(file, BODY, { input: { path: file, offset: 2 } }))).toBeUndefined();
	});

	it("leaves images, errors, nested calls and short texts alone, and forgets a file and the whole context", async () => {
		const file = join(dir, "notes.txt");
		writeFileSync(file, BODY);
		const cache = new ReadCache();
		const image = readResult(file, "Read image file [image/png]", {
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
		});
		for (const result of [
			image,
			readResult(file, BODY, { isError: true }),
			readResult(file, BODY, { nested: true }),
		]) {
			expect(await cache.onRead(result)).toBeUndefined();
			expect(await cache.onRead(result)).toBeUndefined();
		}
		writeFileSync(file, "tiny");
		await cache.onRead(readResult(file, "tiny"));
		expect(await cache.onRead(readResult(file, "tiny"))).toBeUndefined();

		writeFileSync(file, BODY);
		await cache.onRead(readResult(file, BODY));
		cache.forgetFile(file);
		expect(await cache.onRead(readResult(file, BODY))).toBeUndefined();
		cache.clear();
		expect(cache.size).toBe(0);
		expect(await cache.onRead(readResult(file, BODY))).toBeUndefined();
	});
});

function shellResult(output: string, overrides: Partial<EeToolResult> = {}): EeToolResult {
	return {
		toolName: "bash",
		toolCallId: "call_bash",
		nested: false,
		input: { command: "npm test" },
		content: [{ type: "text", text: output }],
		isError: false,
		cwd: dir,
		...overrides,
	};
}

describe("output trimming", () => {
	const noisy = (count: number) => Array.from({ length: count }, (_, index) => `ok ${index + 1} - passes quietly`);

	it("keeps the error lines and the tail under a summary, and writes the full output to a private file", () => {
		const lines = noisy(200);
		lines[49] = "src/app.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.";
		lines[120] = "FAIL test/app.test.ts > adds";
		lines.push("Command exited with code 1");
		const output = lines.join("\n");
		const trimmed = trimToolOutput(shellResult(output, { isError: true }), { outputDir: dir });
		const result = text(trimmed?.change) ?? "";
		const [summary, ...rest] = result.split("\n");
		expect(summary).toBe(
			`[output trimmed to ${2 + TAIL_LINES} of 201 lines by token saving: 2 error lines and the last ${TAIL_LINES} lines kept. Full output: ${trimmed?.fullOutputPath}]`,
		);
		expect(rest).toEqual([
			"… 49 lines …",
			lines[49],
			"… 70 lines …",
			lines[120],
			`… ${201 - TAIL_LINES - 121} lines …`,
			...lines.slice(-TAIL_LINES),
		]);
		expect(rest.at(-1)).toBe("Command exited with code 1");
		expect(readFileSync(trimmed?.fullOutputPath ?? "", "utf8")).toBe(output);
		expect(statSync(trimmed?.fullOutputPath ?? "").mode & 0o777).toBe(0o600);
		expect(trimmed?.savedTokens).toBe(Math.ceil(output.length / 4) - Math.ceil(result.length / 4));
	});

	it("points at the core's file when the core already cut the output, and leaves short or other outputs alone", () => {
		const output = noisy(TRIM_MIN_LINES + 40).join("\n");
		const core = join(dir, "core-full.log");
		const trimmed = trimToolOutput(shellResult(output, { details: { fullOutputPath: core } }), { outputDir: dir });
		expect(trimmed?.fullOutputPath).toBe(core);
		expect(text(trimmed?.change)).toContain(
			`0 error lines and the last ${TAIL_LINES} lines kept. Full output: ${core}]`,
		);

		expect(trimToolOutput(shellResult(noisy(TRIM_MIN_LINES).join("\n")), { outputDir: dir })).toBeUndefined();
		expect(trimToolOutput(shellResult(output, { toolName: "grep" }), { outputDir: dir })).toBeUndefined();
		expect(trimToolOutput(shellResult(output, { nested: true }), { outputDir: dir })).toBeUndefined();
		expect(trimToolOutput(shellResult(output, { toolName: "powershell" }), { outputDir: dir })).toBeDefined();
	});

	it("recognises common error lines", () => {
		for (const line of [
			"npm ERR! code ELIFECYCLE",
			"Traceback (most recent call last):",
			"thread 'main' panicked at src/main.rs:2:5",
			"✗ adds two numbers",
			"bash: foo: command not found",
			"warning: unused variable `x`",
		]) {
			expect(isErrorLine(line), line).toBe(true);
		}
		expect(isErrorLine("ok 1 - passes quietly")).toBe(false);
	});
});

describe("diff edits", () => {
	it("counts a successful edit as the whole file minus the replacements sent", async () => {
		const file = join(dir, "app.ts");
		writeFileSync(file, BODY);
		const edits = [{ oldText: "line 2 of", newText: "line two of" }];
		const result: EeToolResult = {
			toolName: "edit",
			toolCallId: "call_edit",
			nested: false,
			input: { path: file, edits },
			content: [{ type: "text", text: "Successfully replaced 1 block(s)" }],
			isError: false,
			cwd: dir,
			path: file,
		};
		expect(await diffEditSaving(result)).toBe(
			Math.ceil(BODY.length / 4) - Math.ceil(JSON.stringify(edits).length / 4),
		);
		expect(await diffEditSaving({ ...result, isError: true })).toBeUndefined();
		expect(await diffEditSaving({ ...result, toolName: "write" })).toBeUndefined();
	});

	it("asks the model for edits instead of rewrites, and an edit or write makes the file's next read fresh", async () => {
		const saving = new TokenSaving({ outputDir: dir });
		const guidelines = saving.hooks.toolGuidelines?.() ?? {};
		expect(guidelines.write?.[0]).toContain("use edit");
		expect(guidelines.read?.[0]).toContain("from cache, read once");

		const file = join(dir, "notes.txt");
		writeFileSync(file, BODY);
		await saving.hooks.toolResult?.(readResult(file, BODY));
		await saving.hooks.toolResult?.({
			...readResult(file, "Successfully wrote"),
			toolName: "write",
			input: { path: file, content: BODY },
		});
		expect(await saving.hooks.toolResult?.(readResult(file, BODY))).toBeUndefined();
	});
});

const LOW: EeEntitlement = {
	signedIn: true,
	source: "connect",
	org: "org_1",
	orgName: "Acme",
	tier: "low",
	fingersEnabled: true,
};

describe("token saving in a session (real gate, edition extension and read tool)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		ee.tokenSaving.reset();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const longShell: AgentTool = {
		name: "bash",
		label: "bash",
		description: "Run a command",
		parameters: Type.Object({ command: Type.String() }),
		execute: async () => ({
			content: [
				{
					type: "text",
					text: [
						...Array.from({ length: 150 }, (_, index) => `ok ${index + 1}`),
						"error: build failed",
						...Array.from({ length: 30 }, (_, index) => `tail ${index + 1}`),
					].join("\n"),
				},
			],
			details: {},
		}),
	};

	async function session(entitlement: EeEntitlement) {
		const hooks = new EditionToolHooks();
		const savings = new SavingsLedger();
		const gate = new EditionGate({ loadModule: async () => ee, toolHooks: hooks, savings });
		await gate.setEntitlement(entitlement);
		const harness = await createHarness({
			tools: [createReadTool(process.cwd()), longShell],
			extensionFactories: [{ name: "edition", factory: createEditionExtension({ hooks, savings }) }],
		});
		harnesses.push(harness);
		const file = join(harness.tempDir, "notes.txt");
		writeFileSync(file, BODY);
		const requests: string[] = [];
		const reply = (toolCall?: ReturnType<typeof fauxToolCall>) => (context: { messages: unknown[] }) => {
			requests.push(JSON.stringify(context));
			return toolCall ? fauxAssistantMessage([toolCall], { stopReason: "toolUse" }) : fauxAssistantMessage("ok");
		};
		return { gate, savings, harness, file, requests, reply };
	}

	/** The text of the last tool result the model was sent in a request. */
	function lastToolResult(request: string): string {
		const messages = (JSON.parse(request) as { messages: { role: string; content: { text?: string }[] }[] }).messages;
		const result = messages.findLast((message) => message.role === "toolResult");
		return result?.content.map((block) => block.text ?? "").join("") ?? "";
	}

	it("sends no file body for a second read of an unchanged file, and the body again once it changed", async () => {
		const { savings, harness, file, requests, reply } = await session(LOW);
		harness.setResponses([
			reply(fauxToolCall("read", { path: file })),
			reply(fauxToolCall("read", { path: file })),
			reply(),
		]);
		await harness.session.prompt("read the notes twice");
		expect(lastToolResult(requests[1] ?? "")).toBe(BODY);
		expect(lastToolResult(requests[2] ?? "")).toBe(readCacheNote(file));
		expect((requests[2] ?? "").split("line 7 of the notes").length - 1).toBe(1);
		expect(requests[0]).toContain("from cache, read once");
		expect(savings.totals().byTechnique.read_cache.count).toBe(1);
		expect(savings.entries()[0]).toMatchObject({ technique: "read_cache", toolName: "read" });

		writeFileSync(file, `${BODY}\nchanged`);
		harness.setResponses([reply(fauxToolCall("read", { path: file })), reply()]);
		await harness.session.prompt("read it again");
		expect(lastToolResult(requests[4] ?? "")).toBe(`${BODY}\nchanged`);
	});

	it("reads again after compaction rebuilt the context", async () => {
		const { harness, file, requests, reply } = await session(LOW);
		harness.setResponses([reply(fauxToolCall("read", { path: file })), reply()]);
		await harness.session.prompt("read the notes");
		harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		harness.setResponses([fauxAssistantMessage("summary of the notes")]);
		await harness.session.compact();
		harness.setResponses([reply(fauxToolCall("read", { path: file })), reply()]);
		await harness.session.prompt("read them again");
		expect(lastToolResult(requests.at(-1) ?? "")).toBe(BODY);
	});

	it("trims a long shell output to its errors and tail and records the saving", async () => {
		const { savings, harness, requests, reply } = await session(LOW);
		harness.setResponses([reply(fauxToolCall("bash", { command: "npm run build" })), reply()]);
		await harness.session.prompt("build it");
		const sent = lastToolResult(requests[1] ?? "");
		expect(sent).toMatch(
			/^\[output trimmed to 21 of 181 lines by token saving: 1 error line and the last 20 lines kept/,
		);
		expect(sent).toContain("error: build failed");
		expect(sent).toContain("tail 30");
		expect(sent).not.toContain("ok 75\n");
		expect(savings.totals().byTechnique.output_trim.count).toBe(1);
		const path = sent.match(/Full output: (\S+)\]/)?.[1] ?? "";
		expect(readFileSync(path, "utf8")).toContain("ok 75\n");
		rmSync(path, { force: true });
	});

	it("changes nothing on the Free tier, where token saving is off", async () => {
		const { savings, harness, file, requests, reply } = await session({ ...LOW, tier: "free" });
		harness.setResponses([
			reply(fauxToolCall("read", { path: file })),
			reply(fauxToolCall("read", { path: file })),
			reply(fauxToolCall("bash", { command: "npm run build" })),
			reply(),
		]);
		await harness.session.prompt("read twice and build");
		expect(lastToolResult(requests[2] ?? "")).toBe(BODY);
		expect(lastToolResult(requests[3] ?? "")).toContain("ok 75\n");
		expect(requests[0]).not.toContain("Token saving is on");
		expect(savings.totals().tokens).toBe(0);
	});

	it("stops the moment the person signs out", async () => {
		const { gate, harness, file, requests, reply } = await session(LOW);
		harness.setResponses([reply(fauxToolCall("read", { path: file })), reply()]);
		await harness.session.prompt("read the notes");
		await gate.setEntitlement({ signedIn: false, source: "none", fingersEnabled: false });
		harness.setResponses([reply(fauxToolCall("read", { path: file })), reply()]);
		await harness.session.prompt("read them again");
		expect(lastToolResult(requests.at(-1) ?? "")).toBe(BODY);
	});
});
