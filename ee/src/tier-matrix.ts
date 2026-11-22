// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * The tier matrix: the lowest Veyra tier that includes each ee feature. Connect keeps one tier per organization for
 * every app (free, low, medium, high); Connect's tier catalog turns Fingers ee off on Free and on from Low, and this
 * matrix splits the features inside that.
 *
 * The numbers are placeholders like Connect's catalog (`final: false`). Change TIER_MATRIX_VERSION with every change,
 * so a report or a support question can name the matrix it was decided with.
 */
import type { EeFeatureId, VeyraTier } from "@veyraco/fingers";

export const TIER_MATRIX_VERSION = "2026-11-22.1";

export const TIER_MATRIX: Readonly<Record<EeFeatureId, VeyraTier>> = Object.freeze({
	token_saving: "low",
	subagents: "medium",
	checkpoints: "medium",
	brain: "medium",
	eyes: "medium",
	org_hooks: "high",
});

export function minimumTier(feature: EeFeatureId): VeyraTier | undefined {
	return Object.hasOwn(TIER_MATRIX, feature) ? TIER_MATRIX[feature] : undefined;
}
