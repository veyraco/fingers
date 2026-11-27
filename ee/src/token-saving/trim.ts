// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * Tool-output trimming with a summary ("output trimmed to N lines"): a long shell output reaches the model as its
 * error lines and its tail, under one summary line that says what was dropped and where the full output is.
 *
 * Only bash and PowerShell results longer than TRIM_MIN_LINES lines are trimmed (search and file tools return what
 * was asked for). The tail (the last TAIL_LINES lines) always stays: it holds the summary of most tools, the core's
 * "Full output" note and the exit status. Before the tail, every line that looks like an error stays (up to
 * MAX_ERROR_LINES, the first ones), with a "… n lines …" mark for each gap. Nothing is lost: the full output is in a
 * file (the core's own file when it already cut the output, otherwise one written here, readable by this user only).
 */
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EeToolResult, EeToolResultChange } from "@veyraco/fingers";
import { estimateTokens, singleText } from "./text.ts";

export const TRIM_MIN_LINES = 60;
export const TAIL_LINES = 20;
const MAX_ERROR_LINES = 30;

const TRIMMED_TOOLS = new Set(["bash", "powershell"]);

/** Lines that report a problem in common tools' output (compilers, test runners, package managers, shells). */
const ERROR_LINE =
	/\b(?:errors?|fail(?:s|ed|ing|ures?)?|fatal|panic(?:ked)?|exception|traceback|abort(?:ed)?|denied|refused|cannot|can't|unable to|not found|no such file|segmentation fault|warning|not ok)\b|\berr!|[✗✘×⨯]/i;

export function isErrorLine(line: string): boolean {
	return ERROR_LINE.test(line);
}

interface TrimResult {
	change: EeToolResultChange;
	savedTokens: number;
	keptLines: number;
	totalLines: number;
	fullOutputPath: string;
}

export interface TrimOptions {
	/** Where a full output is written when the core did not keep one. Default: the OS temporary directory. */
	outputDir?: string;
}

function coreFullOutputPath(details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const path = (details as { fullOutputPath?: unknown }).fullOutputPath;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

function gap(lines: number): string {
	return `… ${lines} ${lines === 1 ? "line" : "lines"} …`;
}

/** The trimmed text of a long shell output, or undefined when it is short enough or not a shell output. */
export function trimToolOutput(result: EeToolResult, options: TrimOptions = {}): TrimResult | undefined {
	if (result.nested || !TRIMMED_TOOLS.has(result.toolName)) return undefined;
	const text = singleText(result.content);
	if (text === undefined) return undefined;
	const lines = text.split("\n");
	if (lines.length <= TRIM_MIN_LINES) return undefined;

	const tailStart = lines.length - TAIL_LINES;
	const errorIndexes: number[] = [];
	let moreErrors = 0;
	for (let index = 0; index < tailStart; index++) {
		if (!isErrorLine(lines[index] ?? "")) continue;
		if (errorIndexes.length < MAX_ERROR_LINES) errorIndexes.push(index);
		else moreErrors++;
	}

	const body: string[] = [];
	let next = 0;
	for (const index of errorIndexes) {
		if (index > next) body.push(gap(index - next));
		body.push(lines[index] ?? "");
		next = index + 1;
	}
	if (tailStart > next) body.push(gap(tailStart - next));
	body.push(...lines.slice(tailStart));

	let fullOutputPath = coreFullOutputPath(result.details);
	let wroteFile = false;
	if (!fullOutputPath) {
		fullOutputPath = join(options.outputDir ?? tmpdir(), `fingers-output-${randomUUID()}.log`);
		try {
			writeFileSync(fullOutputPath, text, { mode: 0o600, flag: "wx" });
			wroteFile = true;
		} catch {
			// Without a file to point at, the dropped lines would be lost: send the output as it is.
			return undefined;
		}
	}

	const keptLines = errorIndexes.length + TAIL_LINES;
	const errors = errorIndexes.length === 1 ? "1 error line" : `${errorIndexes.length} error lines`;
	const more = moreErrors > 0 ? ` (${moreErrors} more error lines only in the file)` : "";
	const summary = `[output trimmed to ${keptLines} of ${lines.length} lines by token saving: ${errors}${more} and the last ${TAIL_LINES} lines kept. Full output: ${fullOutputPath}]`;
	const trimmed = [summary, ...body].join("\n");
	const savedTokens = estimateTokens(text) - estimateTokens(trimmed);
	if (savedTokens <= 0) {
		if (wroteFile) rmSync(fullOutputPath, { force: true });
		return undefined;
	}
	return {
		change: { content: [{ type: "text", text: trimmed }] },
		savedTokens,
		keptLines,
		totalLines: lines.length,
		fullOutputPath,
	};
}
