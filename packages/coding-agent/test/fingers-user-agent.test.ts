import { describe, expect, it } from "vitest";
import { getFingersUserAgent } from "../src/utils/fingers-user-agent.ts";

describe("getFingersUserAgent", () => {
	it("formats the fingers user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getFingersUserAgent("1.2.3");

		expect(userAgent).toBe(`fingers/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^fingers\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
