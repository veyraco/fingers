// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * Fingers ee: the features the MIT core switches on after `fingers login` when the organization has Fingers on and
 * its tier includes them. The core finds this module at run time (packages/coding-agent/src/core/edition/loader.ts)
 * and never imports it; this module only uses the core's types.
 */
import type { EeHost, EeModule } from "@veyraco/fingers";
import { minimumTier, TIER_MATRIX_VERSION } from "./tier-matrix.ts";

/** The core contract this module was built for (the core's EE_API_VERSION). */
export const apiVersion = 1;

export const matrixVersion = TIER_MATRIX_VERSION;

export { minimumTier };

export function activate(host: EeHost): void {
	if (host.isOn("subagents")) {
		// The sub-agents panel (start, watch, steer, stop) is Fingers item F19; until then /agents says it is on.
		host.registerCommand("agents", (context) => {
			const org = context.entitlement.orgName ?? context.entitlement.org ?? "your organization";
			const tier = context.entitlement.tier ? ` (tier ${context.entitlement.tier})` : "";
			context.showStatus(
				`Sub-agents are on for ${org}${tier}. Starting and steering them from /agents comes in the next Fingers release.`,
			);
		});
	}
}

const eeModule: EeModule = { apiVersion, matrixVersion, minimumTier, activate };
export default eeModule;
