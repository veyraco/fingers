import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalFingersExperimental = process.env.FINGERS_EXPERIMENTAL;

	afterEach(() => {
		if (originalFingersExperimental === undefined) {
			delete process.env.FINGERS_EXPERIMENTAL;
		} else {
			process.env.FINGERS_EXPERIMENTAL = originalFingersExperimental;
		}
	});

	it("returns false when FINGERS_EXPERIMENTAL is unset", () => {
		delete process.env.FINGERS_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when FINGERS_EXPERIMENTAL is empty", () => {
		process.env.FINGERS_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when FINGERS_EXPERIMENTAL is set to 1", () => {
		process.env.FINGERS_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when FINGERS_EXPERIMENTAL is set to 0", () => {
		process.env.FINGERS_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when FINGERS_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.FINGERS_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
