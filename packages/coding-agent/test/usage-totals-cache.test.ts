import { describe, expect, it } from "vitest";
import { cacheHitPercent, createUsageTotals, formatCacheHit } from "../src/core/usage-totals.ts";

describe("prompt-cache hit ratio from usage", () => {
	it("is the share of all prompt tokens (new input, cache reads, cache writes) read from the cache", () => {
		const totals = { ...createUsageTotals(), input: 1500, cacheRead: 8200, cacheWrite: 300 };
		expect(cacheHitPercent(totals)).toBeCloseTo(82, 10);
		expect(formatCacheHit(totals)).toBe("cache 82%");
	});

	it("rounds down to whole percent, so it never shows 100% unless every prompt token was a cache read", () => {
		expect(formatCacheHit({ ...createUsageTotals(), input: 1, cacheRead: 999 })).toBe("cache 99%");
		expect(formatCacheHit({ ...createUsageTotals(), input: 0, cacheRead: 999 })).toBe("cache 100%");
		expect(formatCacheHit({ ...createUsageTotals(), input: 999, cacheWrite: 1 })).toBe("cache 0%");
	});

	it("is undefined until a provider reports cache activity", () => {
		expect(cacheHitPercent(createUsageTotals())).toBeUndefined();
		expect(formatCacheHit({ ...createUsageTotals(), input: 5000 })).toBeUndefined();
	});
});
