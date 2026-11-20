import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			testTimeout: 30000,
			// Tests run offline by default; opt in with allowNetwork() from test/test-network-env.ts.
			// Tests never touch the developer's OS keychain; keychain tests inject a fake store.
			env: { FINGERS_OFFLINE: "1", FINGERS_CREDENTIAL_STORE: "file" },
			unstubEnvs: true,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
			server: {
				deps: {
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
		resolve: {
			alias: [
				{ find: /^@veyraco\/fingers-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@veyraco\/fingers-agent$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@veyraco\/fingers-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@veyraco\/fingers-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
				{ find: /^@veyraco\/fingers-agent$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@veyraco\/fingers-tui$/, replacement: workspaceSourcePaths.tuiIndex },
			],
		},
	}),
);
