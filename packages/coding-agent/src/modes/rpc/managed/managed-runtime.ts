/**
 * The agent runtime managed mode builds after `configure`, under the fixed managed policy: no extension,
 * package, skill, prompt template or theme discovery, the project is never trusted (so a repository cannot
 * change settings or add MCP servers), no cache warming, and only the built-in MCP extension and the managed
 * extension are loaded. The session works in `workspace.root`. `configure.system_prompt` ends the system prompt.
 */

import { join } from "node:path";
import type { ThinkingLevel } from "@veyraco/fingers-agent";
import { getAgentDir } from "../../../config.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../core/agent-session-runtime.ts";
import { AuthStorage } from "../../../core/auth-storage.ts";
import type { InlineExtension } from "../../../core/extensions/types.ts";
import { MEMORY_TOOL_NAMES } from "../../../core/memory/extension.ts";
import { ModelRuntime } from "../../../core/model-runtime.ts";
import { SessionManager } from "../../../core/session-manager.ts";
import { DEFAULT_TOOL_NAMES, type Settings, SettingsManager } from "../../../core/settings-manager.ts";
import { builtInExtensions } from "../../../extensions/index.ts";
import { AGENTS_TOOL } from "../../../extensions/subagents/index.ts";
import type { ManagedRuntimeFactory, ManagedRuntimeFactoryInput } from "./managed-rpc-server.ts";
import { OPENAI_COMPATIBLE_PROVIDER, openAICompatibleProvider } from "./openai-compatible.ts";

export interface ManagedRuntimeOptions {
	/** Fingers' agent directory (sessions, models.json; never credentials). Default: `~/.fingers/agent` or FINGERS_CODING_AGENT_DIR. */
	agentDir?: string;
	/** Directory for session files. Default: under the agent directory. */
	sessionDir?: string;
	/** Settings applied over the global settings (for tests: retry delays). */
	settingsOverrides?: Partial<Settings>;
}

const MANAGED_BUILTIN_EXTENSIONS = new Set(["mcp"]);

export function createManagedRuntimeFactory(options: ManagedRuntimeOptions = {}): ManagedRuntimeFactory {
	return async ({ configure, extension }: ManagedRuntimeFactoryInput): Promise<AgentSessionRuntime> => {
		const agentDir = options.agentDir ?? getAgentDir();
		const cwd = configure.workspace.root;
		const builtin = builtInExtensions.filter(
			(entry) => typeof entry !== "function" && MANAGED_BUILTIN_EXTENSIONS.has(entry.name),
		);
		const tools = [
			...(configure.tools?.builtin ?? DEFAULT_TOOL_NAMES),
			"mcp__*",
			// The memory relay's tools (the managed extension registers them with `memory.mode: relay`).
			...(configure.memory?.mode === "relay" ? MEMORY_TOOL_NAMES : []),
			// Sub-agents (F18b): the managed extension registers the `agents` tool with `subagents.enabled`.
			...(configure.subagents?.enabled ? [AGENTS_TOOL] : []),
		];
		// `configure.system_prompt` is added after any append prompt the loader found. It goes through the
		// override, not `appendSystemPrompt`: the loader reads an `appendSystemPrompt` entry that names an
		// existing file as that file, and the host's text must reach the model verbatim.
		const hostSystemPrompt = configure.system_prompt;
		const appendSystemPromptOverride = hostSystemPrompt ? (base: string[]) => [...base, hostSystemPrompt] : undefined;

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd: runtimeCwd,
			agentDir: runtimeAgentDir,
			sessionManager,
			sessionStartEvent,
		}) => {
			const settingsManager = SettingsManager.create(runtimeCwd, runtimeAgentDir, { projectTrusted: false });
			settingsManager.applyOverrides({ cacheWarming: "off", ...options.settingsOverrides });
			// Credentials come only from the host's `credentials` message: never from auth.json or the
			// machine's OS keychain, so a managed run cannot pick up keys stored by a person on this machine.
			// An `openai-compatible` model is in no catalog: Fingers builds it from `configure.model.model_id`.
			const modelRuntime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath: join(runtimeAgentDir, "models.json"),
				signal: AbortSignal.timeout(15_000),
				extraProviders:
					configure.model.provider === OPENAI_COMPATIBLE_PROVIDER
						? [openAICompatibleProvider(configure.model.model_id)]
						: [],
			});
			const services = await createAgentSessionServices({
				cwd: runtimeCwd,
				agentDir: runtimeAgentDir,
				settingsManager,
				modelRuntime,
				resourceLoaderOptions: {
					// Discovery off; the built-in MCP extension is loaded explicitly, like `-e builtin:mcp`.
					noExtensions: true,
					additionalExtensionPaths: [...MANAGED_BUILTIN_EXTENSIONS].map((name) => `builtin:${name}`),
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					appendSystemPromptOverride,
					extensionFactories: [...builtin, extension] as InlineExtension[],
				},
			});
			const model = services.modelRuntime.getModel(configure.model.provider, configure.model.model_id);
			if (!model) throw new Error(`Unknown model: ${configure.model.provider}/${configure.model.model_id}`);
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model,
				thinkingLevel: configure.model.thinking_level as ThinkingLevel | undefined,
				tools,
			});
			return { ...created, services, diagnostics: services.diagnostics };
		};

		const sessionManager = SessionManager.create(cwd, options.sessionDir);
		return createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
	};
}
