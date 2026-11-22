/**
 * The Veyra sign-in's log: one JSON object per line in the platform log format (veyraco/platform
 * contracts/v1/logging.md: time, level, msg, service, version, env, request_id, trace_id, span_id), appended to
 * `veyra.log` in the agent directory, because stderr would draw over the terminal app. Several fingers processes may
 * write to it, so each record is one synchronous append; past 1 MB it is rotated to `veyra.log.1`.
 *
 * Callers never pass a token, a device code or a user code. Fields named like secrets are redacted at any depth as a
 * second guard.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export type VeyraLogLevel = "debug" | "info" | "warn" | "error";

export interface VeyraLog {
	log(level: VeyraLogLevel, msg: string, fields?: Record<string, unknown>): void;
}

export const silentVeyraLog: VeyraLog = { log: () => {} };

const MAX_LOG_BYTES = 1024 * 1024;

/** The platform's redaction list (contracts/v1/logging.md) and the OAuth secrets of this client. */
const SECRET_KEYS = new Set([
	"authorization",
	"cookie",
	"set-cookie",
	"api_key",
	"client_secret",
	"token",
	"access_token",
	"refresh_token",
	"id_token",
	"device_code",
	"user_code",
	"code",
	"client_assertion",
	"assertion",
	"password",
	"secret",
	"credential",
]);

function redact(value: unknown, depth = 0): unknown {
	if (depth > 20 || value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		result[key] = SECRET_KEYS.has(key.toLowerCase()) ? "[redacted]" : redact(item, depth + 1);
	}
	return result;
}

/** `err: { type, message, stack }` (contracts/v1/logging.md). */
function serializeError(value: unknown): unknown {
	if (value instanceof Error) return { type: value.name, message: value.message, stack: value.stack };
	return { type: "Error", message: String(value) };
}

export interface VeyraLogOptions {
	path: string;
	version: string;
	env: string;
	now?: () => Date;
	/** Lowest level written. Default `info` (FINGERS_LOG_LEVEL in the CLI). */
	level?: VeyraLogLevel;
}

const LEVELS: VeyraLogLevel[] = ["debug", "info", "warn", "error"];

/** Appends platform log records to `path`. Write errors are ignored: logging must never break a sign-in. */
export function createVeyraLog(options: VeyraLogOptions): VeyraLog {
	const minLevel = LEVELS.indexOf(options.level ?? "info");
	let size: number | undefined;
	const currentSize = () => {
		try {
			return statSync(options.path).size;
		} catch {
			return 0;
		}
	};
	return {
		log(level, msg, fields = {}) {
			if (LEVELS.indexOf(level) < minLevel) return;
			const record: Record<string, unknown> = {
				time: (options.now?.() ?? new Date()).toISOString(),
				level,
				msg,
				service: "fingers",
				version: options.version,
				env: options.env,
			};
			for (const [key, value] of Object.entries(fields)) {
				if (value === undefined) continue;
				record[key] = key === "err" ? serializeError(value) : value;
			}
			const line = `${JSON.stringify(redact(record))}\n`;
			try {
				if (size === undefined) {
					mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
					size = currentSize();
				}
				if (size > MAX_LOG_BYTES) {
					// Another process may have rotated it already; check before renaming.
					if (currentSize() > MAX_LOG_BYTES) renameSync(options.path, `${options.path}.1`);
					size = currentSize();
				}
				appendFileSync(options.path, line, { mode: 0o600 });
				size += Buffer.byteLength(line);
			} catch {
				// Best effort.
			}
		},
	};
}
