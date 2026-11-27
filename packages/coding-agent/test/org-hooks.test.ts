/**
 * Organization hooks in the MIT core (F23): reading the person's Fingers policy from Connect (platform connect.yaml
 * `getMyFingersPolicy`, with `If-None-Match`), checking the answer as a whole, the ee contract's tool-call hooks
 * (a failing hook makes the call wait for the person), the built-in `org-hooks` extension that carries out a block or
 * an ask before the personal approvals, and the organization's rules at the end of the system prompt.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditionGate } from "../src/core/edition/gate.ts";
import { EditionToolHooks } from "../src/core/edition/tool-hooks.ts";
import type { EeFingersPolicySource, EeHost, EeModule, EeToolCall } from "../src/core/edition/types.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { InMemorySecretStore } from "../src/core/os-keychain.ts";
import { normalizeBuildSystemPromptOptions } from "../src/core/system-prompt.ts";
import { FingersPolicyError, parseFingersPolicy } from "../src/core/veyra/fingers-policy.ts";
import { VeyraApiError } from "../src/core/veyra/oidc-client.ts";
import { openVeyraSessionVault } from "../src/core/veyra/session-vault.ts";
import { VeyraAuth } from "../src/core/veyra/veyra-auth.ts";
import { createVeyraLog } from "../src/core/veyra/veyra-log.ts";
import { createEditionExtension } from "../src/extensions/edition/index.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { type AskOrgHook, createOrgHooksExtension, type OrgHookRecord } from "../src/extensions/org-hooks/index.ts";
import { type ApprovalAnswer, ApprovalBoxComponent } from "../src/modes/interactive/components/approval-box.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { FAKE_ORG, FakeConnect } from "./veyra-fake-connect.ts";

const POLICY = {
	org_id: FAKE_ORG.id,
	group_id: "grp_editor",
	revision: "rev1",
	instructions: "Never commit secrets.\nRun the tests before every commit.",
	hooks: [
		{
			id: "no-force-push",
			event: "before_tool_call",
			tools: ["bash"],
			pattern: "git push --force*",
			decision: "block",
			message: "Force pushes are not allowed in this organization.",
		},
		{
			id: "env-files",
			event: "before_tool_call",
			tools: ["*"],
			pattern: "*.env",
			decision: "ask",
			message: "Secrets.",
		},
	],
	allowed_providers: ["anthropic"],
	allowed_models: null,
	default_task_budget_usd: 5,
};

describe("parseFingersPolicy", () => {
	it("reads Connect's FingersEffectivePolicy", () => {
		expect(parseFingersPolicy(POLICY, FAKE_ORG.id)).toEqual({
			org: FAKE_ORG.id,
			groupId: "grp_editor",
			revision: "rev1",
			instructions: POLICY.instructions,
			hooks: POLICY.hooks,
			allowedProviders: ["anthropic"],
			allowedModels: null,
			defaultTaskBudgetUsd: 5,
		});
	});

	it("skips a hook for an event this Fingers does not know, keeping the others", () => {
		const later = { ...POLICY.hooks[0], id: "later", event: "after_tool_call" };
		expect(parseFingersPolicy({ ...POLICY, hooks: [later, POLICY.hooks[1]] }, FAKE_ORG.id).hooks).toEqual([
			POLICY.hooks[1],
		]);
	});

	it("refuses the whole answer when it is for another organization or breaks the contract, naming no value", () => {
		const hook = POLICY.hooks[0]!;
		const bad: Array<[string, unknown]> = [
			["not an object", "nope"],
			["another organization", { ...POLICY, org_id: "org_other" }],
			["no revision", { ...POLICY, revision: "" }],
			["instructions with a control character", { ...POLICY, instructions: "a\u001bb" }],
			["instructions too long", { ...POLICY, instructions: "x".repeat(20_001) }],
			["hooks not a list", { ...POLICY, hooks: {} }],
			["too many hooks", { ...POLICY, hooks: Array.from({ length: 51 }, (_, i) => ({ ...hook, id: `h${i}` })) }],
			["bad hook id", { ...POLICY, hooks: [{ ...hook, id: "Bad_Id" }] }],
			["duplicate hook id", { ...POLICY, hooks: [hook, hook] }],
			["no tools", { ...POLICY, hooks: [{ ...hook, tools: [] }] }],
			["bad tool name", { ...POLICY, hooks: [{ ...hook, tools: ["Bash"] }] }],
			["empty pattern", { ...POLICY, hooks: [{ ...hook, pattern: "" }] }],
			["unknown decision", { ...POLICY, hooks: [{ ...hook, decision: "allow" }] }],
			["bidi message", { ...POLICY, hooks: [{ ...hook, message: "ok‮evil" }] }],
			["empty message", { ...POLICY, hooks: [{ ...hook, message: "" }] }],
			["bad providers", { ...POLICY, allowed_providers: [] }],
			["bad models", { ...POLICY, allowed_models: ["no spaces allowed"] }],
			["bad budget", { ...POLICY, default_task_budget_usd: 0 }],
		];
		for (const [name, body] of bad) {
			const error = (() => {
				try {
					parseFingersPolicy(body, FAKE_ORG.id);
					return undefined;
				} catch (caught) {
					return caught;
				}
			})();
			expect(error, name).toBeInstanceOf(FingersPolicyError);
			expect(String((error as Error).message), name).not.toContain("evil");
		}
	});
});

describe("VeyraAuth.fingersPolicy", () => {
	let agentDir: string;
	let fake: FakeConnect | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "fingers-org-hooks-"));
	});

	afterEach(async () => {
		await fake?.stop();
		fake = undefined;
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function signedIn(): Promise<{ auth: VeyraAuth; connect: FakeConnect }> {
		fake = await new FakeConnect({ resources: ["connect"] }).start();
		const auth = new VeyraAuth({
			issuer: fake.issuer,
			vault: openVeyraSessionVault({
				agentDir,
				issuer: fake.issuer,
				env: { FINGERS_CREDENTIAL_STORE: "keychain" },
				secretStore: new InMemorySecretStore(),
			}),
			apiUrl: fake.issuer,
			appVersion: "0.1.0",
			log: createVeyraLog({ path: join(agentDir, "veyra.log"), version: "0.1.0", env: "test" }),
			sleep: async () => {},
		});
		await auth.login({ onCode: () => {}, signal: new AbortController().signal });
		return { auth, connect: fake };
	}

	it("reads the policy with the Connect token, then sends its revision and gets 'unchanged'", async () => {
		const { auth, connect } = await signedIn();
		connect.fingersPolicy = POLICY;
		const first = await auth.fingersPolicy();
		expect(first).toMatchObject({ changed: true, policy: { revision: "rev1", groupId: "grp_editor" } });
		expect(await auth.fingersPolicy({ revision: "rev1" })).toEqual({ changed: false });
		const reads = connect.requestsTo(`/connect/v1/organizations/${FAKE_ORG.id}/fingers-policy/mine`);
		expect(reads.map((request) => request.headers["if-none-match"])).toEqual([undefined, '"rev1"']);
		expect(String(reads[0]?.headers.authorization)).toMatch(/^Bearer /);

		connect.fingersPolicy = { ...POLICY, revision: "rev2", hooks: [] };
		expect(await auth.fingersPolicy({ revision: "rev1" })).toMatchObject({
			changed: true,
			policy: { revision: "rev2", hooks: [] },
		});
	});

	it("rejects Connect's refusal and an answer for another organization", async () => {
		const { auth, connect } = await signedIn();
		connect.fingersPolicy = POLICY;
		connect.fingersPolicyAnswer = { status: 403, body: { status: 403, code: "forbidden", title: "Forbidden" } };
		const refused = await auth.fingersPolicy().catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(VeyraApiError);
		expect((refused as VeyraApiError).status).toBe(403);

		connect.fingersPolicyAnswer = undefined;
		connect.fingersPolicy = { ...POLICY, org_id: "org_other" };
		expect(await auth.fingersPolicy().catch((error: unknown) => error)).toBeInstanceOf(FingersPolicyError);
	});
});

const CALL: EeToolCall = { toolName: "bash", toolCallId: "t1", nested: false, input: { command: "ls" }, cwd: "/repo" };

function hooksWith(...registered: Array<Parameters<EditionToolHooks["set"]>[0][number]>): EditionToolHooks {
	const hooks = new EditionToolHooks();
	hooks.set(registered, () => true);
	return hooks;
}

describe("EditionToolHooks.beforeToolCall", () => {
	it("asks the hooks in order; the first that decides wins, and the hook can't change the call's input", async () => {
		const seen: string[] = [];
		const hooks = hooksWith(
			{
				feature: "token_saving",
				hooks: {
					beforeToolCall: (call) => {
						seen.push("first");
						(call.input as Record<string, unknown>).command = "rm -rf /";
						return undefined;
					},
				},
			},
			{
				feature: "org_hooks",
				hooks: {
					beforeToolCall: async (call) => {
						seen.push(`second ${String(call.input.command)}`);
						return { decision: "block", message: "no", source: "organization hook “x”" };
					},
				},
			},
		);
		const input = { command: "ls" };
		expect(await hooks.beforeToolCall({ ...CALL, input })).toEqual({
			decision: "block",
			message: "no",
			source: "organization hook “x”",
		});
		expect(seen).toEqual(["first", "second ls"]);
		expect(input.command).toBe("ls");
	});

	it("makes the call wait for the person when a hook throws or answers nonsense (fail closed)", async () => {
		const errors: unknown[] = [];
		const throwing = new EditionToolHooks({ onError: (error) => errors.push(error) });
		throwing.set(
			[
				{
					feature: "org_hooks",
					hooks: {
						beforeToolCall: () => {
							throw new Error("broken");
						},
					},
				},
			],
			() => true,
		);
		expect((await throwing.beforeToolCall(CALL))?.decision).toBe("ask");
		expect(errors).toHaveLength(1);

		const nonsense = hooksWith({
			feature: "org_hooks",
			hooks: { beforeToolCall: () => ({ decision: "allow" }) as never },
		});
		expect((await nonsense.beforeToolCall(CALL))?.decision).toBe("ask");
	});

	it("asks no hook of a feature that is off", async () => {
		const hooks = new EditionToolHooks();
		hooks.set(
			[
				{
					feature: "org_hooks",
					hooks: { beforeToolCall: () => ({ decision: "block", message: "x", source: "y" }) },
				},
			],
			() => false,
		);
		expect(hooks.hasToolCallHooks).toBe(false);
		expect(await hooks.beforeToolCall(CALL)).toBeUndefined();
	});
});

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

function orgHooksSetup(hooks: EditionToolHooks, answers: ApprovalAnswer[] = []) {
	const asked: Array<{ summary: string; isCommand: boolean; reason: string }> = [];
	const ask: AskOrgHook = async (_ctx, request) => {
		asked.push(request);
		const answer = answers.shift();
		if (!answer) throw new Error("unexpected question");
		return answer;
	};
	let handler: Handler | undefined;
	const records: Array<{ customType: string; data: OrgHookRecord }> = [];
	const api = {
		on: (event: string, fn: Handler) => {
			if (event === "tool_call") handler = fn;
			return () => {};
		},
		appendEntry: (customType: string, data: OrgHookRecord) => records.push({ customType, data }),
	} as unknown as ExtensionAPI;
	createOrgHooksExtension({ hooks, ask })(api);
	const call = (toolName: string, input: Record<string, unknown>, mode: ExtensionContext["mode"] = "tui") =>
		handler!({ type: "tool_call", toolCallId: "t1", toolName, input }, {
			mode,
			hasUI: mode === "tui",
			cwd: "/repo",
			sessionManager: { getSessionId: () => "session-1" },
		} as unknown as ExtensionContext);
	return { asked, call, records };
}

describe("org-hooks extension", () => {
	it("is a built-in extension that runs before the personal approvals", () => {
		const names = builtInExtensions.map((extension) => extension.name);
		expect(names).toContain("org-hooks");
		expect(names.indexOf("org-hooks")).toBeLessThan(names.indexOf("approvals"));
	});

	it("changes nothing without tool-call hooks (core only)", async () => {
		const { call, records } = orgHooksSetup(new EditionToolHooks());
		expect(await call("bash", { command: "git push --force" })).toBeUndefined();
		expect(records).toEqual([]);
	});

	it("blocks what a hook blocks, passes the resolved path, and records the decision", async () => {
		const calls: EeToolCall[] = [];
		const hooks = hooksWith({
			feature: "org_hooks",
			hooks: {
				beforeToolCall: (call) => {
					calls.push(call);
					return { decision: "block", message: "Not here.", source: "organization hook “no-env”" };
				},
			},
		});
		const { call, records, asked } = orgHooksSetup(hooks);
		expect(await call("write", { path: "config/.env", content: "x" })).toEqual({
			block: true,
			reason: "Your organization's policy does not allow this call (organization hook “no-env”): Not here.",
		});
		expect(calls[0]).toMatchObject({ toolName: "write", path: "/repo/config/.env", cwd: "/repo", nested: false });
		expect(asked).toEqual([]);
		expect(records).toEqual([
			{
				customType: "org_hook",
				data: {
					sessionId: "session-1",
					toolCallId: "t1",
					tool: "write",
					source: "organization hook “no-env”",
					decision: "blocked",
				},
			},
		]);
	});

	it("asks the person for an ask hook; yes runs the call, no blocks it with what they said", async () => {
		const hooks = hooksWith({
			feature: "org_hooks",
			hooks: {
				beforeToolCall: () => ({ decision: "ask", message: "Check first.", source: "organization hook “deploy”" }),
			},
		});
		const { call, records, asked } = orgHooksSetup(hooks, [
			{ decision: "allow_once" },
			{ decision: "deny", message: "use the staging script" },
		]);
		expect(await call("bash", { command: "./deploy.sh" })).toBeUndefined();
		expect(await call("bash", { command: "./deploy.sh" })).toEqual({
			block: true,
			reason: "The user did not allow this call and said what to do instead: use the staging script",
		});
		expect(asked[0]).toEqual({
			summary: "./deploy.sh",
			isCommand: true,
			reason: "Organization policy (organization hook “deploy”): Check first.",
		});
		expect(records.map((record) => record.data.decision)).toEqual(["allow_once", "deny"]);
	});

	it("refuses an ask hook's call where no one can be asked", async () => {
		const hooks = hooksWith({
			feature: "org_hooks",
			hooks: {
				beforeToolCall: () => ({ decision: "ask", message: "Check first.", source: "organization hook “x”" }),
			},
		});
		const { call, records } = orgHooksSetup(hooks);
		expect(await call("bash", { command: "ls" }, "print")).toMatchObject({ block: true });
		expect(records[0]?.data.decision).toBe("no_one_to_ask");
	});
});

describe("approval box for an organization hook", () => {
	it("offers no 'always allow' and its key does nothing", () => {
		initTheme("dark");
		const answers: ApprovalAnswer[] = [];
		const box = new ApprovalBoxComponent({
			action: "run a command",
			summary: "./deploy.sh",
			isCommand: true,
			reason: "Organization policy",
			allowPattern: "./deploy.sh",
			allowAlways: false,
			onAnswer: (answer) => answers.push(answer),
		});
		expect(box.render(100).join("\n")).not.toContain("always allow");
		box.handleInput("a");
		expect(answers).toEqual([]);
		box.handleInput("\t");
		expect(box.selectedChoice).toBe(2);
		box.handleInput("\t");
		expect(box.selectedChoice).toBe(0);
		box.handleInput("y");
		expect(answers).toEqual([{ decision: "allow_once" }]);
	});
});

describe("organization rules in the system prompt", () => {
	it("adds the text of the features that are on after the person's own appended text", async () => {
		const hooks = hooksWith({
			feature: "org_hooks",
			hooks: { systemPrompt: () => "# Organization rules\n\nBe nice." },
		});
		let handler: ((event: unknown) => unknown) | undefined;
		const api = {
			on: (event: string, fn: (event: unknown) => unknown) => {
				if (event === "before_agent_start") handler = fn;
				return () => {};
			},
		} as unknown as ExtensionAPI;
		createEditionExtension({ hooks })(api);
		const options = normalizeBuildSystemPromptOptions({
			appendSystemPrompt: "Mine.",
			selectedTools: [],
			cwd: "/repo",
		});
		await handler!({ type: "before_agent_start", systemPromptOptions: options });
		expect(options.appendSystemPrompt).toBe("Mine.\n\n# Organization rules\n\nBe nice.");

		const off = new EditionToolHooks();
		off.set([{ feature: "org_hooks", hooks: { systemPrompt: () => "Rules" } }], () => false);
		let offHandler: ((event: unknown) => unknown) | undefined;
		createEditionExtension({ hooks: off })({
			on: (event: string, fn: (event: unknown) => unknown) => {
				if (event === "before_agent_start") offHandler = fn;
				return () => {};
			},
		} as unknown as ExtensionAPI);
		const untouched = normalizeBuildSystemPromptOptions({
			appendSystemPrompt: "Mine.",
			selectedTools: [],
			cwd: "/repo",
		});
		await offHandler!({ type: "before_agent_start", systemPromptOptions: untouched });
		expect(untouched.appendSystemPrompt).toBe("Mine.");
	});
});

describe("the gate hands ee the policy only while signed in", () => {
	it("passes the policy source to ee, and none when signed out", async () => {
		const source: EeFingersPolicySource = { org: FAKE_ORG.id, read: async () => ({ changed: false }) };
		const seen: Array<EeFingersPolicySource | undefined> = [];
		const module: EeModule = {
			apiVersion: 9,
			matrixVersion: "t",
			minimumTier: () => "high",
			activate: (host: EeHost) => {
				seen.push(host.fingersPolicy());
			},
		};
		const gate = new EditionGate({ loadModule: async () => module, fingersPolicy: () => source });
		await gate.setEntitlement({
			signedIn: true,
			source: "connect",
			org: FAKE_ORG.id,
			tier: "high",
			fingersEnabled: true,
		});
		await gate.setEntitlement({ signedIn: false, source: "none", fingersEnabled: false });
		expect(seen).toEqual([source, undefined]);
	});
});
