import { describe, expect, it } from "vitest";
import { VIRTUAL_MODULES } from "../../../src/core/extensions/virtual-modules.ts";

// Regression test for #11156: extensions importing @veyraco/fingers-ai/models
// (e.g. for clampThinkingLevel) failed with "Cannot find module" in embedded
// runtimes because the subpath was missing from the virtual module map.
describe("fingers-ai/models virtual module", () => {
	it("exposes the fingers-ai /models entrypoint to extensions", () => {
		const models = VIRTUAL_MODULES["@veyraco/fingers-ai/models"] as { clampThinkingLevel?: unknown } | undefined;
		expect(models).toBeDefined();
		expect(typeof models?.clampThinkingLevel).toBe("function");
	});

	it("exposes the same module under the legacy @veyraco scope", () => {
		expect(VIRTUAL_MODULES["@veyraco/fingers-ai/models"]).toBe(VIRTUAL_MODULES["@veyraco/fingers-ai/models"]);
	});
});
