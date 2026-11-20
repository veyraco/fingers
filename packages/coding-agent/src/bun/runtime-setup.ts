import { bedrockProviderModule } from "@veyraco/fingers-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@veyraco/fingers-ai/bun-oauth";
import { setBedrockProviderModule, setVertexTokenSource } from "@veyraco/fingers-ai/compat";
import { googleAdcTokenSource } from "@veyraco/fingers-ai/vertex-auth-provider";
// Bun loads .wasm imports as files: embedded in compiled executables, evaluating to a readable path.
import quickjsWasmPath from "quickjs-wasi/quickjs.wasm";
import { APP_NAME, setEmbeddedQuickJSWasmPath } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
setVertexTokenSource(googleAdcTokenSource);
setEmbeddedQuickJSWasmPath(quickjsWasmPath);
