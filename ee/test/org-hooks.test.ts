// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * Organization hooks (F23): the glob of connect.yaml `FingersHook.pattern`, which call a hook applies to, the policy
 * read and re-read by revision, fail closed while no policy for the signed-in organization is known, the
 * organization's rules in the prompt, `/hooks`, and the feature only on a tier that includes it.
 */
import type {
	EeCommandContext,
	EeFingersPolicy,
	EeFingersPolicyRead,
	EeFingersPolicySource,
	EeHost,
	EeOrgHook,
	EeToolCall,
} from "@veyraco/fingers";
import { describe, expect, it } from "vitest";
import { EditionGate } from "../../packages/coding-agent/src/core/edition/gate.ts";
import { EditionToolHooks } from "../../packages/coding-agent/src/core/edition/tool-hooks.ts";
import * as ee from "../src/index.ts";
import { callSubjects, globMatches, matchingHook, OrgHooks } from "../src/org-hooks/index.ts";

const ORG = "org_7aR2cT";

const FORCE_PUSH: EeOrgHook = {
	id: "no-force-push",
	event: "before_tool_call",
	tools: ["bash"],
	pattern: "git push --force*",
	decision: "block",
	message: "Force pushes are not allowed.",
};
const ENV_FILES: EeOrgHook = {
	id: "env-files",
	event: "before_tool_call",
	tools: ["*"],
	pattern: "*.env",
	decision: "ask",
	message: "This touches a secrets file.",
};
const SRC_WRITES: EeOrgHook = {
	id: "src-writes",
	event: "before_tool_call",
	tools: ["write", "edit"],
	pattern: "src/*",
	decision: "ask",
	message: "Ask before changing src.",
};

function policy(overrides: Partial<EeFingersPolicy> = {}): EeFingersPolicy {
	return {
		org: ORG,
		groupId: "grp_editor",
		revision: "rev1",
		instructions: "Never commit secrets.",
		hooks: [FORCE_PUSH, ENV_FILES],
		allowedProviders: null,
		allowedModels: null,
		defaultTaskBudgetUsd: null,
		...overrides,
	};
}

function call(toolName: string, input: Record<string, unknown>, path?: string): EeToolCall {
	return { toolName, toolCallId: "t1", nested: false, input, cwd: "/repo", ...(path ? { path } : {}) };
}

describe("globMatches", () => {
	it("matches the whole subject: * any run, ? one character, the rest literal and case-sensitive", () => {
		expect(globMatches("git push --force*", "git push --force-with-lease origin main")).toBe(true);
		expect(globMatches("git push --force*", "echo; git push --force")).toBe(false);
		expect(globMatches("*git push --force*", "echo; git push --force")).toBe(true);
		expect(globMatches("*.env", "/repo/config/.env")).toBe(true);
		expect(globMatches("*.env", "/repo/.env.example")).toBe(false);
		expect(globMatches("rm -?f *", "rm -rf /")).toBe(true);
		expect(globMatches("RM *", "rm x")).toBe(false);
		expect(globMatches("a.c", "abc")).toBe(false);
		expect(globMatches("[ab]*", "[ab]x")).toBe(true);
		expect(globMatches("*", "")).toBe(true);
		expect(globMatches("?", "é")).toBe(true);
	});

	it("stays fast on a long subject with many stars", () => {
		const started = performance.now();
		expect(globMatches(`${"*a".repeat(40)}*b`, "a".repeat(20_000))).toBe(false);
		expect(performance.now() - started).toBeLessThan(2_000);
	});
});

describe("matchingHook", () => {
	it("applies a hook to the tools it names and the command or path of the call; the first match decides", () => {
		const hooks = [FORCE_PUSH, ENV_FILES, SRC_WRITES];
		expect(matchingHook(hooks, call("bash", { command: "git push --force origin" }))?.id).toBe("no-force-push");
		expect(matchingHook(hooks, call("bash", { command: "git push origin" }))).toBeUndefined();
		expect(matchingHook(hooks, call("powershell", { command: "git push --force" }))).toBeUndefined();
		expect(matchingHook(hooks, call("read", { path: ".env" }, "/repo/.env"))?.id).toBe("env-files");
		expect(matchingHook(hooks, call("bash", { command: "cat .env" }))?.id).toBe("env-files");
		// Relative to the working directory too, so `src/*` matches however the model names the file.
		expect(matchingHook(hooks, call("write", { path: "./src/a.ts" }, "/repo/src/a.ts"))?.id).toBe("src-writes");
		expect(
			matchingHook(hooks, call("write", { path: "/elsewhere/src/a.ts" }, "/elsewhere/src/a.ts")),
		).toBeUndefined();
		// A tool with no subject only meets hooks without a pattern.
		expect(matchingHook(hooks, call("browser", { url: "https://x.env" }))).toBeUndefined();
		const everyCall: EeOrgHook = { ...ENV_FILES, id: "all", pattern: null };
		expect(matchingHook([everyCall], call("browser", {}))?.id).toBe("all");
	});

	it("reads the subject from the command for shells and from the resolved path for file tools", () => {
		expect(callSubjects(call("bash", { command: "ls" }))).toEqual(["ls"]);
		expect(callSubjects(call("bash", { command: 3 }))).toEqual([]);
		expect(callSubjects(call("ls", {}, "/repo"))).toEqual(["/repo", "."]);
		expect(callSubjects(call("read", { path: "../x" }, "/x"))).toEqual(["/x"]);
	});
});

class FakeSource implements EeFingersPolicySource {
	org: string | undefined = ORG;
	current: EeFingersPolicy | undefined = policy();
	failWith: Error | undefined;
	readonly reads: Array<string | undefined> = [];

	async read(options: { revision?: string } = {}): Promise<EeFingersPolicyRead> {
		this.reads.push(options.revision);
		if (this.failWith) throw this.failWith;
		if (!this.current) throw new Error("404 not_found");
		if (options.revision === this.current.revision) return { changed: false };
		return { changed: true, policy: this.current };
	}
}

function attached(source: FakeSource, clock = { now: 1_000_000 }) {
	const hooks = new OrgHooks({ now: () => clock.now, readTimeoutMs: 50 });
	const commands = new Map<string, (context: EeCommandContext) => void | Promise<void>>();
	const host = {
		fingersPolicy: () => source,
		registerToolHooks: () => {},
		registerCommand: (name: string, handler: (context: EeCommandContext) => void | Promise<void>) =>
			commands.set(name, handler),
	} as unknown as EeHost;
	hooks.attach(host);
	const run = async (args = "") => {
		const out: string[] = [];
		await commands.get("hooks")!({
			args,
			cwd: "/repo",
			entitlement: { signedIn: true, source: "connect", fingersEnabled: true },
			showStatus: (message) => out.push(`status: ${message}`),
			showWarning: (message) => out.push(`warning: ${message}`),
		});
		return out.join("\n");
	};
	return { hooks, clock, run };
}

describe("OrgHooks", () => {
	it("blocks, asks and lets through by the organization's hooks", async () => {
		const { hooks } = attached(new FakeSource());
		await hooks.refresh();
		const check = hooks.hooks.beforeToolCall!;
		expect(await check(call("bash", { command: "git push --force" }))).toEqual({
			decision: "block",
			message: "Force pushes are not allowed.",
			source: "organization hook “no-force-push”",
		});
		expect((await check(call("edit", { path: "a.env" }, "/repo/a.env")))?.decision).toBe("ask");
		expect(await check(call("bash", { command: "pnpm test" }))).toBeUndefined();
	});

	it("reads again with its revision once the last read is a minute old, and applies a changed policy", async () => {
		const source = new FakeSource();
		const { hooks, clock } = attached(source);
		await hooks.refresh();
		const check = hooks.hooks.beforeToolCall!;
		await check(call("bash", { command: "ls" }));
		expect(source.reads).toEqual([undefined]);
		clock.now += 60_000;
		await check(call("bash", { command: "ls" }));
		expect(source.reads).toEqual([undefined, "rev1"]);
		source.current = policy({ revision: "rev2", hooks: [{ ...FORCE_PUSH, pattern: null }] });
		clock.now += 60_000;
		expect((await check(call("bash", { command: "ls" })))?.decision).toBe("block");
		expect(source.reads).toEqual([undefined, "rev1", "rev1"]);
	});

	it("asks before every call while no policy for the signed-in organization could be read (fail closed)", async () => {
		const source = new FakeSource();
		source.failWith = new Error("Connect could not be reached");
		const { hooks, run } = attached(source);
		const decision = await hooks.hooks.beforeToolCall!(call("read", { path: "x" }, "/repo/x"));
		expect(decision?.decision).toBe("ask");
		expect(decision?.source).toBe("organization policy");
		expect(await run()).toContain("Connect could not be reached");

		// A read that fails later keeps the policy read before.
		source.failWith = undefined;
		await hooks.refresh();
		source.failWith = new Error("offline");
		await hooks.refresh();
		expect(await hooks.hooks.beforeToolCall!(call("bash", { command: "ls" }))).toBeUndefined();
	});

	it("drops the policy of an organization the sign-in moved away from", async () => {
		const source = new FakeSource();
		const { hooks } = attached(source);
		await hooks.refresh();
		source.org = "org_other";
		source.failWith = new Error("offline");
		expect(hooks.current()).toBeUndefined();
		expect(hooks.hooks.systemPrompt!()).toBeUndefined();
		expect((await hooks.hooks.beforeToolCall!(call("bash", { command: "ls" })))?.decision).toBe("ask");
	});

	it("adds the organization's rules to the prompt", async () => {
		const { hooks } = attached(new FakeSource());
		await hooks.refresh();
		expect(hooks.hooks.systemPrompt!()).toBe(
			"# Organization rules\n\nYour organization set these rules for every Fingers session in Veyra Connect. Follow them.\n\nNever commit secrets.",
		);
	});

	it("/hooks lists the hooks from the org policy; /hooks refresh reads them again", async () => {
		const source = new FakeSource();
		const { hooks, run } = attached(source);
		await hooks.refresh();
		const text = await run();
		expect(text).toContain("Hooks · 2 from org policy");
		expect(text).toContain("no-force-push · block · bash · “git push --force*” · Force pushes are not allowed.");
		expect(text).toContain("env-files · ask · * · “*.env”");
		expect(text).toContain("Organization rules: 21 characters");
		await run("refresh");
		expect(source.reads).toEqual([undefined, "rev1"]);
		expect(await run("nonsense")).toBe("warning: Usage: /hooks, /hooks refresh");
	});
});

describe("org_hooks through the gate", () => {
	async function gateAt(tier: string, source: FakeSource) {
		const toolHooks = new EditionToolHooks();
		const gate = new EditionGate({ loadModule: async () => ee, toolHooks, fingersPolicy: () => source });
		await gate.setEntitlement({ signedIn: true, source: "connect", org: ORG, tier, fingersEnabled: true });
		return { gate, toolHooks };
	}

	it("is on only on a tier that includes it, and then blocks by the organization's hooks", async () => {
		const medium = await gateAt("medium", new FakeSource());
		expect(medium.toolHooks.hasToolCallHooks).toBe(false);
		expect(medium.gate.commandHandler("hooks")).toBeUndefined();

		const high = await gateAt("high", new FakeSource());
		expect(high.toolHooks.hasToolCallHooks).toBe(true);
		expect(high.gate.commandHandler("hooks")).toBeDefined();
		expect((await high.toolHooks.beforeToolCall(call("bash", { command: "git push --force" })))?.decision).toBe(
			"block",
		);

		await high.gate.setEntitlement({ signedIn: false, source: "none", fingersEnabled: false });
		expect(high.toolHooks.hasToolCallHooks).toBe(false);
	});
});
