/**
 * Managed mode's structured logs: one JSON object per line on stderr in the platform log format
 * (contracts/v1/logging.md, `service: "fingers"`), with the run's ids and the latest command's trace ids.
 * Secret values and the platform's secret keys are redacted at any depth.
 */
import type { SecretSet } from "./secrets.ts";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

const SECRET_KEYS = new Set([
	"authorization",
	"cookie",
	"set-cookie",
	"password",
	"secret",
	"token",
	"access_token",
	"refresh_token",
	"api_key",
	"client_secret",
	"credential",
	"headers",
]);

export interface ManagedLoggerOptions {
	write: (line: string) => void;
	secrets: SecretSet;
	version: string;
	env: string;
	now?: () => Date;
	/** Lowest level written. Default `info`. */
	level?: LogLevel;
}

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error", "fatal"];

export class ManagedLogger {
	private readonly options: ManagedLoggerOptions;
	private run: { run_id?: string; request_id?: string } = {};
	private trace: { trace_id?: string; span_id?: string } = {};

	constructor(options: ManagedLoggerOptions) {
		this.options = options;
	}

	setRun(run: { runId?: string; requestId?: string }): void {
		this.run = { run_id: run.runId, request_id: run.requestId };
	}

	setTrace(trace: { traceId: string; spanId: string }): void {
		this.trace = { trace_id: trace.traceId, span_id: trace.spanId };
	}

	debug(msg: string, fields?: Record<string, unknown>): void {
		this.log("debug", msg, fields);
	}
	info(msg: string, fields?: Record<string, unknown>): void {
		this.log("info", msg, fields);
	}
	warn(msg: string, fields?: Record<string, unknown>): void {
		this.log("warn", msg, fields);
	}
	error(msg: string, fields?: Record<string, unknown>): void {
		this.log("error", msg, fields);
	}

	log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
		if (LEVELS.indexOf(level) < LEVELS.indexOf(this.options.level ?? "info")) return;
		const record: Record<string, unknown> = {
			time: (this.options.now?.() ?? new Date()).toISOString(),
			level,
			msg,
			service: "fingers",
			version: this.options.version,
			env: this.options.env,
			...definedOnly(this.run),
			...definedOnly(this.trace),
		};
		for (const [key, value] of Object.entries(fields)) {
			if (value === undefined) continue;
			record[key] = key === "err" ? serializeError(value) : value;
		}
		try {
			// Values only: the line stays valid JSON however short a secret is.
			this.options.write(`${this.options.secrets.redactJsonLine(JSON.stringify(redactKeys(record)))}\n`);
		} catch {
			// Logging must never break the run.
		}
	}
}

function definedOnly(fields: Record<string, string | undefined>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(fields)) if (value !== undefined) result[key] = value;
	return result;
}

function serializeError(value: unknown): unknown {
	if (value instanceof Error) return { type: value.name, message: value.message, stack: value.stack };
	return { type: "Error", message: String(value) };
}

function redactKeys(value: unknown, depth = 0): unknown {
	if (depth > 20 || value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((item) => redactKeys(item, depth + 1));
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		result[key] = SECRET_KEYS.has(key.toLowerCase()) ? "[redacted]" : redactKeys(item, depth + 1);
	}
	return result;
}
