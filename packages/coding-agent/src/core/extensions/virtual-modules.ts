import * as bundledFingersAgentCore from "@veyraco/fingers-agent";
import * as bundledFingersAiModels from "@veyraco/fingers-ai/models";
import * as bundledFingersAiOauth from "@veyraco/fingers-ai/oauth";
import * as bundledFingersAiProviders from "@veyraco/fingers-ai/providers/all";
import * as bundledFingersTui from "@veyraco/fingers-tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @veyraco/fingers.
import * as bundledFingersCodingAgent from "../../index.ts";
import * as bundledFingersAiExtensionView from "./fingers-ai-extension-view.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@veyraco/fingers-agent": bundledFingersAgentCore,
	"@veyraco/fingers-tui": bundledFingersTui,
	// Extensions resolve the fingers-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint) plus TypeBox's Type, Static and TSchema:
	// existing extensions using the old global API and fingers-ai's former TypeBox
	// re-exports keep working.
	"@veyraco/fingers-ai": bundledFingersAiExtensionView,
	"@veyraco/fingers-ai/compat": bundledFingersAiExtensionView,
	"@veyraco/fingers-ai/models": bundledFingersAiModels,
	"@veyraco/fingers-ai/oauth": bundledFingersAiOauth,
	"@veyraco/fingers-ai/providers/all": bundledFingersAiProviders,
	"@veyraco/fingers": bundledFingersCodingAgent,
};
