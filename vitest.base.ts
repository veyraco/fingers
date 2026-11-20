import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/telemetry/src/testing/index.ts", import.meta.url)),
	mcpIndex: fileURLToPath(new URL("./packages/mcp/src/index.ts", import.meta.url)),
	mcpOAuth: fileURLToPath(new URL("./packages/mcp/src/oauth/index.ts", import.meta.url)),
	mcpTesting: fileURLToPath(new URL("./packages/mcp/src/testing/index.ts", import.meta.url)),
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiModels: fileURLToPath(new URL("./packages/ai/src/models.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiApi: fileURLToPath(new URL("./packages/ai/src/api", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	aiUtils: fileURLToPath(new URL("./packages/ai/src/utils", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	codemodeIndex: fileURLToPath(new URL("./packages/codemode/src/index.ts", import.meta.url)),
	codemodeDeclarations: fileURLToPath(new URL("./packages/codemode/src/declarations.ts", import.meta.url)),
	codemodeSource: fileURLToPath(new URL("./packages/codemode/src/source.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@veyraco\/fingers-telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^@veyraco\/fingers-telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^@veyraco\/fingers-mcp$/, replacement: workspaceSourcePaths.mcpIndex },
			{ find: /^@veyraco\/fingers-mcp\/oauth$/, replacement: workspaceSourcePaths.mcpOAuth },
			{ find: /^@veyraco\/fingers-mcp\/testing$/, replacement: workspaceSourcePaths.mcpTesting },
			{ find: /^@veyraco\/fingers-ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@veyraco\/fingers-ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
		{ find: /^@veyraco\/fingers-ai\/models$/, replacement: workspaceSourcePaths.aiModels },
			{ find: /^@veyraco\/fingers-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^@veyraco\/fingers-ai\/utils\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiUtils}/$1.ts`,
			},
			{
				find: /^@veyraco\/fingers-ai\/api\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiApi}/$1.ts`,
			},
			{
				find: /^@veyraco\/fingers-ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^@veyraco\/fingers-agent$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@veyraco\/fingers-codemode$/, replacement: workspaceSourcePaths.codemodeIndex },
			{ find: /^@veyraco\/fingers-codemode\/declarations$/, replacement: workspaceSourcePaths.codemodeDeclarations },
			{ find: /^@veyraco\/fingers-codemode\/source$/, replacement: workspaceSourcePaths.codemodeSource },
			{ find: /^@veyraco\/fingers-tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
});
