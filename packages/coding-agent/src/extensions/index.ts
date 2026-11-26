import type { InlineExtension } from "../core/extensions/types.ts";
import approvalsExtension from "./approvals/index.ts";
import codemodeExtension from "./codemode/index.ts";
import editionExtension from "./edition/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import memoryExtension from "./memory/index.ts";
import telemetryExtension from "./telemetry/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// The approval box before shell commands in the terminal (`approvals` setting).
	{ name: "approvals", factory: approvalsExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
	// Open core: ee features (token saving) act on tool results through it while they are on; core only, it does
	// nothing. Last, so ee sees each result after the other built-ins.
	{ name: "edition", factory: editionExtension, builtin: true },
	// Open core: Brain memory (an ee feature) acts on sessions through it while it is on; core only, it does nothing.
	{ name: "memory", factory: memoryExtension, builtin: true },
	// Open core: spans of each run go to the person's own OTLP destination (FINGERS_OTLP_ENDPOINT) and to Eyes (an ee
	// feature) while it is on; with neither it makes no span.
	{ name: "telemetry", factory: telemetryExtension, builtin: true },
];
