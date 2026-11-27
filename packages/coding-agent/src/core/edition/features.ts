/**
 * The ee features as people see them: their names, and the built-in slash commands that need them. The core keeps
 * this list so the slash menu can tag ee commands and the locked box can name the feature even without the ee module;
 * which tier includes a feature is the ee module's tier matrix.
 */
import type { EeEntitlement, EeFeatureId, EeFeatureState, VeyraTier } from "./types.ts";

export interface EeFeatureInfo {
	id: EeFeatureId;
	/** "Sub-agents", as the locked box starts its first row. */
	title: string;
	/** "sub-agents", inside a list ("ee features on: token saving · sub-agents · ..."). */
	listName: string;
	/** "Sub-agents are …" or "Token saving is …". */
	plural: boolean;
}

export const EE_FEATURES: Readonly<Record<EeFeatureId, EeFeatureInfo>> = {
	token_saving: { id: "token_saving", title: "Token saving", listName: "token saving", plural: false },
	subagents: { id: "subagents", title: "Sub-agents", listName: "sub-agents", plural: true },
	checkpoints: { id: "checkpoints", title: "Checkpoints", listName: "checkpoints", plural: true },
	brain: { id: "brain", title: "Brain memory", listName: "Brain", plural: false },
	eyes: { id: "eyes", title: "Eyes telemetry", listName: "Eyes", plural: false },
	org_hooks: { id: "org_hooks", title: "Organization hooks", listName: "org hooks", plural: true },
};

/** Built-in slash commands that are ee features (tagged `ee` in the slash menu). */
export const EE_COMMANDS: Readonly<Record<string, EeFeatureId>> = {
	agents: "subagents",
	memory: "brain",
	eyes: "eyes",
	hooks: "org_hooks",
};

/** `/agents` or `/agents <args>` as an ee command: its name and arguments; undefined for any other text. */
export function parseEeCommand(text: string): { name: string; args: string } | undefined {
	const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text);
	const name = match?.[1];
	if (!name || !Object.hasOwn(EE_COMMANDS, name)) return undefined;
	return { name, args: (match[2] ?? "").trim() };
}

/** Where the open-core page explains what is in ee (canvas FingersTuiLocked; the product page lives under veyra.so/fingers). */
export const OPEN_CORE_URL = "veyra.so/fingers/open-core";

/** "token saving · sub-agents · checkpoints · Brain · Eyes · org hooks" for the features given, in canvas order. */
export function formatFeatureList(features: readonly EeFeatureId[]): string {
	return (Object.keys(EE_FEATURES) as EeFeatureId[])
		.filter((id) => features.includes(id))
		.map((id) => EE_FEATURES[id].listName)
		.join(" · ");
}

const TIER_NAMES: Record<VeyraTier, string> = { free: "Free", low: "Low", medium: "Medium", high: "High" };

/** "Medium" for "medium"; an unknown tier as Connect sent it. */
export function tierName(tier: string | undefined): string {
	return tier && Object.hasOwn(TIER_NAMES, tier) ? TIER_NAMES[tier as VeyraTier] : (tier ?? "unknown");
}

/** Why Fingers is core only, in a few words, from the state of the lowest-tier ee feature ("Core only: …"). */
export function coreOnlyText(state: EeFeatureState, entitlement: EeEntitlement): string {
	if (state.on) return "some ee features are off";
	const org = entitlement.orgName ?? entitlement.org ?? "your organization";
	switch (state.reason) {
		case "no_ee":
			return "this Fingers build has no ee/ module.";
		case "signed_out":
			return "not signed in.";
		case "offline":
			return "Veyra Connect has not confirmed your organization's tier yet.";
		case "denied":
			return `Veyra Connect did not confirm ${org}.`;
		case "fingers_off":
			return `the Fingers app is off for ${org}; an admin turns it on in Veyra Connect.`;
		case "unknown_tier":
			return `Veyra Connect reports the tier “${entitlement.tier ?? ""}”, which this Fingers version does not know.`;
		case "tier":
			return `the ${tierName(entitlement.tier)} tier includes no ee features.`;
	}
}
