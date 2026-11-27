/**
 * Secrets a host hands Fingers in managed mode: the model credential and the values of the headers that carry a
 * credential (by name, 8+ characters; the same rule as the Hands runner). They stay in memory; every stdout record,
 * log line, session entry and checkpoint line has them replaced. Replacement works on a record's string values and
 * keys, never on its serialized text, so a value can never change a record's JSON structure.
 */

const REDACTED = "[redacted]";

/** A header value shorter than this is not a secret: replacing a short value everywhere rewrites unrelated text. */
const MIN_SECRET_HEADER_LENGTH = 8;
/** Header names (lowercase) that carry a credential. */
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key"]);
/** Parts of a header name that mark it as carrying a credential. */
const CREDENTIAL_HEADER_PARTS = ["auth", "token", "secret", "key", "password", "session", "signature", "credential"];

/** Whether a header with this name carries a credential. */
function isCredentialHeader(name: string): boolean {
	const lower = name.toLowerCase();
	return CREDENTIAL_HEADERS.has(lower) || CREDENTIAL_HEADER_PARTS.some((part) => lower.includes(part));
}

/**
 * The header values to treat as secrets: those of credential-named headers, 8 characters or more. Other values
 * (`anthropic-version: 2023-06-01`, `x-flag: true`) are not secrets and stay readable.
 */
export function secretHeaderValues(headers: Record<string, string> | undefined): string[] {
	return Object.entries(headers ?? {})
		.filter(([name, value]) => isCredentialHeader(name) && typeof value === "string")
		.map(([, value]) => value)
		.filter((value) => value.length >= MIN_SECRET_HEADER_LENGTH);
}

export class SecretSet {
	private readonly values = new Set<string>();
	/** Registered values and their JSON-escaped spellings, longest first so overlaps redact fully. */
	private patterns: string[] = [];

	add(value: string | undefined): void {
		if (!value || value.length < 4 || this.values.has(value)) return;
		this.values.add(value);
		const spellings = new Set([value, JSON.stringify(value).slice(1, -1)]);
		this.patterns = [...new Set([...this.patterns, ...spellings])].sort((a, b) => b.length - a.length);
	}

	get size(): number {
		return this.values.size;
	}

	containsSecret(text: string): boolean {
		return this.patterns.some((pattern) => text.includes(pattern));
	}

	redact(text: string): string {
		let result = text;
		for (const pattern of this.patterns) {
			if (result.includes(pattern)) result = result.split(pattern).join(REDACTED);
		}
		return result;
	}

	/**
	 * A JSON line with every secret replaced in its string values and keys; the structure is untouched. A line
	 * that is not JSON is redacted as text.
	 */
	redactJsonLine(line: string): string {
		if (!this.containsSecret(line)) return line;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return this.redact(line);
		}
		return JSON.stringify(this.redactValue(parsed));
	}

	/** A copy of `value` with every secret replaced in its strings and object keys. */
	redactValue<T>(value: T): T {
		if (this.patterns.length === 0) return value;
		return this.redactAny(value, new WeakMap()) as T;
	}

	private redactAny(value: unknown, seen: WeakMap<object, unknown>): unknown {
		if (typeof value === "string") return this.redact(value);
		if (value === null || typeof value !== "object") return value;
		const existing = seen.get(value);
		if (existing) return existing;
		if (Array.isArray(value)) {
			const copy: unknown[] = [];
			seen.set(value, copy);
			for (const item of value) copy.push(this.redactAny(item, seen));
			return copy;
		}
		const copy: Record<string, unknown> = {};
		seen.set(value, copy);
		for (const [key, item] of Object.entries(value)) {
			// defineProperty: a `__proto__` key from JSON.parse stays a plain key.
			Object.defineProperty(copy, this.redact(key), {
				value: this.redactAny(item, seen),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return copy;
	}
}
