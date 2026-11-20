/**
 * Secrets a host hands Fingers in managed mode (the model credential and every header value). They stay in
 * memory; every stdout record and log line passes through `redact` so none of them can leave the process.
 */

const REDACTED = "[redacted]";

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

	/** A copy of `value` with every secret replaced in its strings. */
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
		for (const [key, item] of Object.entries(value)) copy[key] = this.redactAny(item, seen);
		return copy;
	}
}
