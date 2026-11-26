/**
 * Memory (open core): the provider interface, the session extension that uses it, the relay provider of managed RPC
 * mode and the process' provider slot the ee gate fills. See types.ts.
 */
export {
	createMemoryExtension,
	DEFAULT_MEMORY_CONTEXT_TOKENS,
	DEFAULT_MEMORY_TIMEOUTS,
	MEMORY_CONTEXT_ENTRY,
	MEMORY_RECALL_TOOL,
	MEMORY_REMEMBER_TOOL,
	MEMORY_SECTION,
	MEMORY_TOOL_NAMES,
	type MemoryExtensionOptions,
	type MemoryTimeouts,
	renderMemorySection,
} from "./extension.ts";
export {
	type GitConfigReader,
	projectRepository,
	readGitConfig,
	repositoryIdFromRemote,
	repositoryShortName,
} from "./project.ts";
export { type MemoryProviderFactory, MemoryProviders, memoryProviders } from "./registry.ts";
export {
	type MemoryRelayOp,
	type MemoryRequestRecord,
	type MemoryResponseRecord,
	RelayMemoryProvider,
} from "./relay.ts";
export {
	MEMORY_TYPES,
	type MemoryCallOptions,
	type MemoryContextRequest,
	type MemoryContextResult,
	type MemoryEventsResult,
	type MemoryLearningEvent,
	type MemoryProvider,
	type MemoryProviderContext,
	type MemoryRecallItem,
	type MemoryRecallRequest,
	type MemoryRef,
	type MemoryRememberRequest,
	type MemoryRememberResult,
	type MemoryType,
	MemoryUnavailableError,
	memoryLabel,
} from "./types.ts";
