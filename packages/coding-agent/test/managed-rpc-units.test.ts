import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from "../src/core/resolve-config-value.ts";
import { childSpan, continueTrace, formatTraceparent, parseTraceparent } from "../src/core/trace-context.ts";
import { ApprovalBroker, approvalNeed, describeManagedTool } from "../src/modes/rpc/managed/approvals.ts";
import { validateCommand, validateOutbound } from "../src/modes/rpc/managed/contract.ts";
import { escapeConfigValue, mcpServerEntries } from "../src/modes/rpc/managed/credentials.ts";
import { FileChangeTracker } from "../src/modes/rpc/managed/file-changes.ts";
import { ManagedLogger } from "../src/modes/rpc/managed/log.ts";
import { checkManagedToolPaths, preparePathPolicy } from "../src/modes/rpc/managed/path-policy.ts";
import { SecretSet } from "../src/modes/rpc/managed/secrets.ts";

const dirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("traceparent", () => {
	it("continues a valid trace with a new span id", () => {
		const parsed = parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba90200-01");
		expect(parsed).toEqual({
			traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
			parentId: "00f067aa0ba90200",
			flags: "01",
		});
		const next = continueTrace("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba90200-01");
		expect(next.valid).toBe(true);
		expect(next.context.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
		expect(next.context.parentSpanId).toBe("00f067aa0ba90200");
		expect(next.context.spanId).toMatch(/^[0-9a-f]{16}$/);
		expect(next.context.spanId).not.toBe("00f067aa0ba90200");
	});

	it("starts a new trace for a missing or invalid traceparent", () => {
		for (const value of [
			undefined,
			"",
			"garbage",
			`00-${"0".repeat(32)}-00f067aa0ba90200-01`,
			`00-${"a".repeat(32)}-${"0".repeat(16)}-01`,
		]) {
			const next = continueTrace(value);
			expect(next.valid, String(value)).toBe(false);
			expect(next.context.traceId).toMatch(/^[0-9a-f]{32}$/);
			expect(next.context.parentSpanId).toBeUndefined();
		}
	});

	it("makes a child span per outgoing call with the parent's trace id and flags", () => {
		const parent = continueTrace("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba90200-00").context;
		const first = childSpan(parent);
		const second = childSpan(parent);
		expect(first).toMatchObject({ traceId: parent.traceId, parentSpanId: parent.spanId, flags: "00" });
		expect(first.spanId).toMatch(/^[0-9a-f]{16}$/);
		expect(new Set([parent.spanId, first.spanId, second.spanId]).size).toBe(3);
		expect(parseTraceparent(formatTraceparent(first))).toEqual({
			traceId: parent.traceId,
			parentId: first.spanId,
			flags: "00",
		});
	});
});

describe("secrets", () => {
	it("redacts every registered value in strings and nested records", () => {
		const secrets = new SecretSet();
		secrets.add("hpt_run01_secret");
		secrets.add("Bearer ghs_header_value");
		expect(secrets.redact("key=hpt_run01_secret and Bearer ghs_header_value")).toBe("key=[redacted] and [redacted]");
		expect(secrets.redactValue({ a: ["x hpt_run01_secret"], b: { c: "Bearer ghs_header_value" }, n: 3 })).toEqual({
			a: ["x [redacted]"],
			b: { c: "[redacted]" },
			n: 3,
		});
		expect(secrets.containsSecret('{"k":"hpt_run01_secret"}')).toBe(true);
		expect(secrets.containsSecret("nothing here")).toBe(false);
	});

	it("also catches the JSON-escaped form of a secret", () => {
		const secrets = new SecretSet();
		secrets.add('tok"en\\value');
		const line = JSON.stringify({ v: 'tok"en\\value' });
		expect(secrets.containsSecret(line)).toBe(true);
		expect(secrets.redact(line)).not.toContain("en\\\\value");
	});
});

describe("managed logger", () => {
	it("writes platform log records with correlation ids and no secrets", () => {
		const lines: string[] = [];
		const secrets = new SecretSet();
		secrets.add("hpt_secret_token");
		const logger = new ManagedLogger({ write: (line) => lines.push(line), secrets, version: "0.1.0", env: "test" });
		logger.setRun({ runId: "run_1", requestId: "req_1" });
		logger.setTrace({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba90201" });
		logger.info("credentials received", { provider: "anthropic", note: "hpt_secret_token", authorization: "x" });
		logger.error("tool failed", { err: new Error("boom hpt_secret_token") });
		const [first, second] = lines.map((line) => JSON.parse(line));
		expect(first).toMatchObject({
			level: "info",
			msg: "credentials received",
			service: "fingers",
			version: "0.1.0",
			env: "test",
			run_id: "run_1",
			request_id: "req_1",
			trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
			span_id: "00f067aa0ba90201",
			provider: "anthropic",
			note: "[redacted]",
			authorization: "[redacted]",
		});
		expect(first.time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
		expect(second.err).toMatchObject({ type: "Error", message: "boom [redacted]" });
		expect(lines.join("\n")).not.toContain("hpt_secret_token");
		expect(lines.every((line) => line.endsWith("\n"))).toBe(true);
	});
});

describe("contract validation", () => {
	it("accepts the contract's own command and rejects invalid ones", () => {
		expect(
			validateCommand({
				id: "c1",
				type: "credentials",
				provider: "anthropic",
				base_url: "https://proxy.example/anthropic",
				credential_kind: "proxy_token",
				credential: "x",
			}).ok,
		).toBe(true);
		const bad = validateCommand({
			id: "c1",
			type: "credentials",
			provider: "anthropic",
			base_url: "http://evil.example/anthropic",
			credential_kind: "proxy_token",
			credential: "x",
		});
		expect(bad.ok).toBe(false);
		expect(validateCommand({ id: "c2", type: "prompt", message: "" }).ok).toBe(false);
	});

	it("checks outbound records against the response and event schemas", () => {
		expect(
			validateOutbound({
				type: "response",
				id: "c1",
				command: "configure",
				success: true,
				data: { session_id: "s" },
			}),
		).toEqual([]);
		expect(
			validateOutbound({ type: "notice", seq: 2, level: "loud", code: "x", message: "m" }).length,
		).toBeGreaterThan(0);
	});
});

describe("path policy", () => {
	async function setup() {
		const root = tempDir("fingers-policy-");
		const workspace = join(root, "workspace");
		const privateDir = join(root, "private");
		mkdirSync(workspace);
		mkdirSync(privateDir);
		writeFileSync(join(privateDir, "secret"), "s");
		const policy = await preparePathPolicy({ workspaceRoot: workspace, protectedPaths: [privateDir] });
		return { root, workspace, privateDir, policy };
	}

	it("admits paths inside the workspace", async () => {
		const { workspace, policy } = await setup();
		writeFileSync(join(workspace, "a.ts"), "a");
		expect(await checkManagedToolPaths("read", { path: "a.ts" }, policy)).toBeNull();
		expect(await checkManagedToolPaths("write", { path: "new/dir/file.ts", content: "" }, policy)).toBeNull();
		expect(await checkManagedToolPaths("ls", {}, policy)).toBeNull();
		expect(await checkManagedToolPaths("grep", { pattern: "x" }, policy)).toBeNull();
		expect(await checkManagedToolPaths("bash", { command: "cat /etc/passwd" }, policy)).toBeNull();
		expect(await checkManagedToolPaths("mcp__github__create_pull_request", { title: "x" }, policy)).toBeNull();
	});

	it("blocks escapes, protected paths and symlinks out of the workspace (ported from Hands)", async () => {
		const { root, workspace, privateDir, policy } = await setup();
		symlinkSync(privateDir, join(workspace, "escape"));
		mkdirSync(join(workspace, "space name"));
		symlinkSync(privateDir, join(workspace, "space name", "escape"));
		const blocked: Array<[string, Record<string, unknown>]> = [
			["write", { path: "escape/new-file", content: "" }],
			["read", { path: "../../outside" }],
			["read", { path: `${privateDir}/secret` }],
			["edit", { path: `@${root}/private/secret`, edits: [] }],
			["write", { path: `file://${root}/private/secret`, content: "" }],
			["write", { path: "~/secret", content: "" }],
			["ls", { path: "~" }],
			["read", { path: "@~/secret" }],
			["write", { path: "space\u00a0name/escape/secret", content: "" }],
			["write", { path: "space\u202fname/escape/secret", content: "" }],
			["write", { path: "a\0b", content: "" }],
			["find", { pattern: "*", path: ".." }],
			["grep", { pattern: "x", path: privateDir }],
			["read", {}],
		];
		for (const [tool, input] of blocked) {
			expect(await checkManagedToolPaths(tool, input, policy), `${tool} ${JSON.stringify(input)}`).not.toBeNull();
		}
		for (const path of [`@${workspace}/safe`, `file://${workspace}/safe`, "space\u00a0name/safe"]) {
			expect(await checkManagedToolPaths("write", { path, content: "" }, policy), path).toBeNull();
		}
		expect(homedir()).not.toBe(workspace);
	});

	it("blocks a protected path inside the workspace and read fallback aliases to private state", async () => {
		const root = tempDir("fingers-policy-");
		const workspace = join(root, "workspace");
		mkdirSync(join(workspace, "protected"), { recursive: true });
		mkdirSync(join(root, "private"));
		const policy = await preparePathPolicy({
			workspaceRoot: workspace,
			protectedPaths: [join(workspace, "protected")],
		});
		expect(await checkManagedToolPaths("write", { path: "protected/x", content: "" }, policy)).not.toBeNull();
		expect(await checkManagedToolPaths("read", { path: `${workspace}/protected` }, policy)).not.toBeNull();
		const aliases = [
			["capture 1 PM.png", "capture 1\u202fPM.png"],
			["caf\u00e9", "cafe\u0301"],
			["a'b", "a\u2019b"],
		];
		for (const [, alternate] of aliases) symlinkSync(join(root, "private"), join(workspace, alternate!));
		for (const [path] of aliases) {
			expect(await checkManagedToolPaths("read", { path }, policy), path).not.toBeNull();
		}
	});

	it("refuses a workspace that is missing or overlaps a protected path", async () => {
		const root = tempDir("fingers-policy-");
		await expect(preparePathPolicy({ workspaceRoot: join(root, "missing"), protectedPaths: [] })).rejects.toThrow();
		mkdirSync(join(root, "ws"));
		await expect(preparePathPolicy({ workspaceRoot: join(root, "ws"), protectedPaths: [root] })).rejects.toThrow(
			/protected/,
		);
	});
});

describe("approvals", () => {
	const servers = ["github", "my-docs"];

	it("classifies tools", () => {
		expect(describeManagedTool("bash", servers)).toEqual({ server: "builtin", name: "bash", kind: "command" });
		expect(describeManagedTool("edit", servers)).toEqual({ server: "builtin", name: "edit", kind: "file_write" });
		expect(describeManagedTool("read", servers)).toEqual({ server: "builtin", name: "read", kind: "other" });
		expect(describeManagedTool("mcp__github__create_pull_request", servers)).toEqual({
			server: "github",
			name: "create_pull_request",
			kind: "mcp_tool",
		});
		expect(describeManagedTool("mcp__my_docs__search", servers)).toEqual({
			server: "my-docs",
			name: "search",
			kind: "mcp_tool",
		});
	});

	it("decides which calls need approval per mode", () => {
		const bash = describeManagedTool("bash", servers);
		const read = describeManagedTool("read", servers);
		const mcp = describeManagedTool("mcp__github__x", servers);
		expect(approvalNeed(bash, "never").required).toBe(false);
		expect(approvalNeed(bash, "write_tools").required).toBe(true);
		expect(approvalNeed(read, "write_tools").required).toBe(false);
		expect(approvalNeed(read, "always").required).toBe(true);
		expect(approvalNeed(mcp, "write_tools")).toEqual({ required: true, reason: "Write tool" });
	});

	function broker(timeoutMs = 1000) {
		const records: Array<Record<string, any>> = [];
		const warnings: string[] = [];
		let n = 0;
		const b = new ApprovalBroker({
			emit: (record) => records.push(record),
			timeoutMs,
			newId: () => `apr_${++n}`,
			warn: (msg) => warnings.push(msg),
		});
		return { b, records, warnings };
	}

	it("round-trips a request, remembers allow_always and ignores a second answer", async () => {
		const { b, records, warnings } = broker();
		const bash = describeManagedTool("bash", servers);
		const pending = b.request({
			toolCallId: "t1",
			tool: bash,
			args: { command: "pnpm vitest run a.test.ts" },
			reason: "Not in your allow list",
		});
		expect(records[0]).toMatchObject({
			type: "approval_request",
			id: "apr_1",
			tool_call_id: "t1",
			tool: { server: "builtin", name: "bash", arguments: { command: "pnpm vitest run a.test.ts" } },
			kind: "command",
			summary: "pnpm vitest run a.test.ts",
			reason: "Not in your allow list",
			allow_always_pattern: "pnpm vitest",
		});
		expect(
			b.respond({
				type: "approval_response",
				id: "apr_1",
				decision: "allow_always",
				decided_by: { type: "person", id: "usr_1" },
			}),
		).toBe(true);
		await expect(pending).resolves.toMatchObject({ decision: "allow_always" });
		expect(records[1]).toEqual({ type: "approval_resolved", id: "apr_1", decision: "allow_always" });
		expect(b.respond({ type: "approval_response", id: "apr_1", decision: "deny" })).toBe(false);
		expect(warnings).toHaveLength(1);
		expect(b.isAllowed(bash, { command: "pnpm vitest run b.test.ts" })).toBe(true);
		expect(b.isAllowed(bash, { command: "pnpm install" })).toBe(false);
	});

	it("never lets an allow_always pattern match PowerShell code in the arguments", async () => {
		const { b } = broker();
		const powershell = describeManagedTool("powershell", servers);
		const pending = b.request({
			toolCallId: "t1",
			tool: powershell,
			args: { command: "pnpm vitest run a.test.ts" },
			reason: "Not in your allow list",
		});
		b.respond({ type: "approval_response", id: "apr_1", decision: "allow_always" });
		await pending;
		expect(b.isAllowed(powershell, { command: "pnpm vitest run b.test.ts" })).toBe(true);
		expect(b.isAllowed(powershell, { command: "pnpm vitest (Start-Process calc)" })).toBe(false);
		expect(b.isAllowed(powershell, { command: "pnpm vitest $env:TOKEN" })).toBe(false);
	});

	it("never lets an allow_always pattern match a bash expansion that runs a program", async () => {
		const { b } = broker();
		const bash = describeManagedTool("bash", servers);
		const pending = b.request({
			toolCallId: "t1",
			tool: bash,
			args: { command: "pnpm vitest run a.test.ts" },
			reason: "Not in your allow list",
		});
		b.respond({ type: "approval_response", id: "apr_1", decision: "allow_always" });
		await pending;
		expect(b.isAllowed(bash, { command: "pnpm vitest run 'b c.test.ts'" })).toBe(true);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a template
		expect(b.isAllowed(bash, { command: "pnpm vitest ${y:=$'a[\\x24(touch P)]'} ${a[y]}" })).toBe(false);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a template
		expect(b.isAllowed(bash, { command: "pnpm vitest ${x@P}" })).toBe(false);
		expect(b.isAllowed(bash, { command: "pnpm vitest <(touch P)" })).toBe(false);
	});

	it("never lets an allow_always pattern match when shellPath names a shell that quotes unlike bash", async () => {
		let shellPath: string | undefined = "/opt/homebrew/bin/fish";
		const b = new ApprovalBroker({
			emit: () => {},
			timeoutMs: 1000,
			newId: () => "apr_1",
			shellPath: () => shellPath,
		});
		const bash = describeManagedTool("bash", servers);
		const pending = b.request({ toolCallId: "t1", tool: bash, args: { command: "echo a" }, reason: "x" });
		b.respond({ type: "approval_response", id: "apr_1", decision: "allow_always" });
		await pending;
		// fish reads \' inside single quotes as an escape: `;touch P;` is not quoted there.
		expect(b.isAllowed(bash, { command: "echo a '\\'X' ;touch P; echo \\'" })).toBe(false);
		expect(b.isAllowed(bash, { command: "echo a b" })).toBe(false);
		shellPath = "/bin/zsh";
		expect(b.isAllowed(bash, { command: "echo a b" })).toBe(true);
	});

	it("expires unanswered requests and cancels on abort", async () => {
		const { b, records } = broker(20);
		const bash = describeManagedTool("bash", servers);
		await expect(
			b.request({ toolCallId: "t", tool: bash, args: { command: "ls" }, reason: "r" }),
		).resolves.toMatchObject({
			decision: "expired",
		});
		expect(records.at(-1)).toMatchObject({ type: "approval_resolved", decision: "expired" });
		const slow = broker(60_000);
		const pending = slow.b.request({ toolCallId: "t", tool: bash, args: { command: "ls" }, reason: "r" });
		slow.b.cancelAll();
		await expect(pending).resolves.toMatchObject({ decision: "cancelled" });
		expect(slow.records.at(-1)).toMatchObject({ type: "approval_resolved", decision: "cancelled" });
	});
});

describe("credential and MCP config values", () => {
	it("escapes values so config resolution keeps them literal", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
		for (const value of ["plain", "$HOME", "${HOME}", "!echo pwned", "a$b!c", "$$", "!"]) {
			expect(resolveConfigValueOrThrow(escapeConfigValue(value), "test")).toBe(value);
			expect(resolveHeadersOrThrow({ h: escapeConfigValue(value) }, "test")).toEqual({ h: value });
		}
	});

	it("turns configure.mcp_servers into direct, allow-listed server registrations", () => {
		const entries = mcpServerEntries([
			{
				name: "github",
				url: "https://mcp.veyra.so/connectors/github",
				headers: { Authorization: "Bearer $tok" },
				allowed_tools: ["create_pull_request", "list_*"],
				approval: "write_tools",
			},
		]);
		expect(entries).toEqual([
			{
				name: "github",
				config: {
					url: "https://mcp.veyra.so/connectors/github",
					headers: { Authorization: "Bearer $$tok" },
					exposure: "hidden",
					toolExposure: { create_pull_request: "direct", "list_*": "direct" },
				},
			},
		]);
		expect(mcpServerEntries([{ name: "docs", url: "https://d.example/mcp" }])[0]!.config).toEqual({
			url: "https://d.example/mcp",
			exposure: "direct",
		});
	});
});

describe("file changes", () => {
	it("reports added, modified and deleted files relative to the workspace", async () => {
		const workspace = tempDir("fingers-changes-");
		writeFileSync(join(workspace, "a.ts"), "one\ntwo\nthree\n");
		const tracker = new FileChangeTracker(workspace);
		await tracker.before("t1", "edit", { path: "a.ts" });
		writeFileSync(join(workspace, "a.ts"), "one\nTWO\nthree\nfour\n");
		expect(await tracker.after("t1")).toEqual({ path: "a.ts", change: "modified", additions: 2, deletions: 1 });
		await tracker.before("t2", "write", { path: "src/new.ts" });
		mkdirSync(join(workspace, "src"));
		writeFileSync(join(workspace, "src/new.ts"), "x\ny\n");
		expect(await tracker.after("t2")).toEqual({ path: "src/new.ts", change: "added", additions: 2, deletions: 0 });
		await tracker.before("t3", "write", { path: "a.ts" });
		expect(await tracker.after("t3")).toBeUndefined();
		await tracker.before("t4", "read", { path: "a.ts" });
		expect(await tracker.after("t4")).toBeUndefined();
	});
});
