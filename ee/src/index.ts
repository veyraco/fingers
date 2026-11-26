// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * Fingers ee: the features the MIT core switches on after `fingers login` when the organization has Fingers on and
 * its tier includes them. The core finds this module at run time (packages/coding-agent/src/core/edition/loader.ts)
 * and never imports it; this module only uses the core's types.
 */
import type { EeHost, EeModule } from "@veyraco/fingers";
import { BrainMemory } from "./brain/index.ts";
import { EyesTelemetry } from "./eyes/index.ts";
import { Subagents } from "./subagents/index.ts";
import { minimumTier, TIER_MATRIX_VERSION } from "./tier-matrix.ts";
import { TokenSaving } from "./token-saving/index.ts";

/** The core contract this module was built for (the core's EE_API_VERSION). */
export const apiVersion = 8;

export const matrixVersion = TIER_MATRIX_VERSION;

export { minimumTier };

/** One per process: its read cache lives across entitlement checks and is cleared when the context is rebuilt. */
export const tokenSaving = new TokenSaving();

/** One per process: the repositories turned off with /memory off stay off across entitlement checks. */
export const brainMemory = new BrainMemory();

/** One per process: its per-organization exporters and /eyes off live across entitlement checks. */
export const eyesTelemetry = new EyesTelemetry();

/** One per process: sub-agent ids and the list /agents shows live across entitlement checks. */
export const subagents = new Subagents();

export function activate(host: EeHost): void {
	if (host.isOn("token_saving")) {
		tokenSaving.attach(host);
		host.registerToolHooks("token_saving", tokenSaving.hooks);
	} else {
		tokenSaving.reset();
	}
	if (host.isOn("brain")) {
		brainMemory.attach(host);
	} else {
		brainMemory.reset();
	}
	if (host.isOn("eyes")) {
		eyesTelemetry.attach(host);
	} else {
		eyesTelemetry.reset();
	}
	if (host.isOn("subagents")) {
		// The `agents` tool and /agents (list, steer, stop); the full panel is F19.
		subagents.attach(host);
	}
}

const eeModule: EeModule = { apiVersion, matrixVersion, minimumTier, activate };
export default eeModule;
