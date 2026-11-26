/**
 * Open core: the MIT core and the ee gate. See types.ts for the contract with `ee/`.
 */
export {
	cachedEntitlement,
	EE_OFFLINE_GRACE_MS,
	type EntitlementSource,
	entitlementAfterLookup,
	resolveEntitlement,
} from "./entitlement.ts";
export {
	coreOnlyText,
	EE_COMMANDS,
	EE_FEATURES,
	type EeFeatureInfo,
	formatFeatureList,
	OPEN_CORE_URL,
	parseEeCommand,
	tierName,
} from "./features.ts";
export { EditionGate, type EditionGateOptions, eeFeatureState } from "./gate.ts";
export { asEeModule, type EeLocation, eeModuleCandidates, loadEeModule } from "./loader.ts";
export { EditionToolHooks, editionToolHooks, savingsLedger } from "./tool-hooks.ts";
export {
	EE_API_VERSION,
	EE_FEATURE_IDS,
	EE_SUBTASK_CLASSES,
	type EeCommandContext,
	type EeCommandHandler,
	type EeCompactionOutcome,
	type EeCompactionPreview,
	type EeContextEdit,
	type EeContextEntry,
	type EeContextView,
	type EeEntitlement,
	type EeEntitlementSource,
	type EeFeatureId,
	type EeFeatureState,
	type EeHost,
	type EeLockReason,
	type EeMemoryProviderFactory,
	type EeModelFacts,
	type EeModule,
	type EeRouteChoice,
	type EeRouteOutcome,
	type EeRouteRequest,
	type EeSubTaskClass,
	type EeToolHooks,
	type EeToolResult,
	type EeToolResultChange,
	type EeVeyraApi,
	type EeVeyraApp,
	isVeyraTier,
	SIGNED_OUT,
	tierIncludes,
	VEYRA_TIERS,
	type VeyraTier,
} from "./types.ts";
