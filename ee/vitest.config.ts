// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
import { defineConfig, mergeConfig } from "vitest/config";
import codingAgentConfig from "../packages/coding-agent/vitest.config.ts";

// The coding agent's settings (offline, no OS keychain, workspace source aliases), for ee/test only.
export default mergeConfig(
	codingAgentConfig,
	defineConfig({
		root: import.meta.dirname,
		test: { include: ["test/**/*.test.ts"] },
	}),
);
