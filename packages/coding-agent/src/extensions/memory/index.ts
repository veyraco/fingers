/**
 * Open core: the built-in extension through which a memory provider acts on the terminal app's sessions (F20). It is
 * MIT and holds no provider: it uses the process' memory providers (core/memory/registry.ts), which the ee gate fills
 * with the Brain provider while Brain is on. With no provider (core only, signed out, a tier without Brain, outside a
 * repository with a remote, print and JSON modes) it changes nothing and offers no memory tools.
 */

import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { createMemoryExtension } from "../../core/memory/extension.ts";
import { type MemoryProviders, memoryProviders } from "../../core/memory/registry.ts";

export function createBuiltinMemoryExtension(providers: MemoryProviders = memoryProviders): ExtensionFactory {
	/** Sessions already told that memory is unavailable: once per session is enough. */
	const told = new Set<string>();
	return createMemoryExtension({
		provider: (cwd) => providers.providerFor(cwd),
		onUnavailable: (error, ctx) => {
			const session = ctx.sessionManager.getSessionId();
			if (told.has(session)) return;
			told.add(session);
			if (ctx.hasUI) ctx.ui.notify(`Memory is unavailable (${error.message}); continuing without it.`, "warning");
		},
	});
}

export default createBuiltinMemoryExtension();
