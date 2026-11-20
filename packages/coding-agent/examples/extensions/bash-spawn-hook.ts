/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   fingers -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@veyraco/fingers";
import { createBashTool } from "@veyraco/fingers";

export default function (fingers: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, FINGERS_SPAWN_HOOK: "1" },
		}),
	});

	fingers.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
