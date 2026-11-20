/**
 * Approvals in managed mode: which tool calls need a decision (`tools.approval`, an MCP server's
 * `approval`), the `approval_request` sent to the host, and the host's `approval_response`.
 */
import { randomBytes } from "node:crypto";

export type ApprovalMode = "never" | "write_tools" | "always";
export type ApprovalKind = "command" | "file_write" | "mcp_tool" | "network" | "other";
export type ApprovalDecision = "allow_once" | "allow_always" | "deny" | "expired" | "cancelled";

export interface ManagedToolDescriptor {
	/** `builtin` or the MCP server name from `configure.mcp_servers`. */
	server: string;
	name: string;
	kind: ApprovalKind;
}

export interface ApprovalOutcome {
	decision: ApprovalDecision;
	reason?: string;
	editedArguments?: Record<string, unknown>;
	decidedBy?: { type: string; id?: string };
}

const COMMAND_TOOLS = new Set(["bash", "powershell"]);
const FILE_WRITE_TOOLS = new Set(["edit", "write"]);

function mcpPrefix(server: string): string {
	return `mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}__`;
}

export function describeManagedTool(toolName: string, mcpServers: readonly string[]): ManagedToolDescriptor {
	if (COMMAND_TOOLS.has(toolName)) return { server: "builtin", name: toolName, kind: "command" };
	if (FILE_WRITE_TOOLS.has(toolName)) return { server: "builtin", name: toolName, kind: "file_write" };
	if (toolName.startsWith("mcp__")) {
		const server = [...mcpServers]
			.sort((a, b) => b.length - a.length)
			.find((name) => toolName.startsWith(mcpPrefix(name)));
		if (server) return { server, name: toolName.slice(mcpPrefix(server).length), kind: "mcp_tool" };
	}
	return { server: "builtin", name: toolName, kind: "other" };
}

export function approvalNeed(tool: ManagedToolDescriptor, mode: ApprovalMode): { required: boolean; reason: string } {
	if (mode === "never") return { required: false, reason: "" };
	if (mode === "always") return { required: true, reason: "Every tool call needs approval" };
	switch (tool.kind) {
		case "command":
			return { required: true, reason: "Not in your allow list" };
		case "file_write":
		case "mcp_tool":
			return { required: true, reason: "Write tool" };
		case "network":
			return { required: true, reason: "Network access" };
		default:
			return { required: false, reason: "" };
	}
}

const SHELL_CHAINING = /[;&|`\n\r<>]|\$\(/;

function commandTokens(args: Record<string, unknown>): string[] {
	return typeof args.command === "string" ? args.command.trim().split(/\s+/).filter(Boolean) : [];
}

function firstLabel(args: Record<string, unknown>): string | undefined {
	for (const value of Object.values(args)) {
		if (typeof value === "string" && value.trim() && value.length <= 80) return value.trim();
	}
	return undefined;
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function approvalSummary(tool: ManagedToolDescriptor, args: Record<string, unknown>): string {
	switch (tool.kind) {
		case "command":
			return truncate(typeof args.command === "string" ? args.command : tool.name, 400);
		case "file_write":
			return truncate(`${tool.name} ${typeof args.path === "string" ? args.path : ""}`.trim(), 400);
		case "mcp_tool": {
			const label = firstLabel(args);
			return truncate(`${tool.server}: ${tool.name}${label ? ` ${label}` : ""}`, 400);
		}
		default:
			return truncate(tool.name, 400);
	}
}

/** What `allow_always` adds to the allow list, so matching calls run without asking. */
export function allowAlwaysPattern(tool: ManagedToolDescriptor, args: Record<string, unknown>): string {
	switch (tool.kind) {
		case "command":
			return commandTokens(args).slice(0, 2).join(" ") || tool.name;
		case "file_write":
			return `${tool.name}:${typeof args.path === "string" ? args.path : ""}`;
		case "mcp_tool":
			return `${tool.server}/${tool.name}`;
		default:
			return tool.name;
	}
}

function patternMatches(pattern: string, tool: ManagedToolDescriptor, args: Record<string, unknown>): boolean {
	if (tool.kind !== "command") return pattern === allowAlwaysPattern(tool, args);
	const command = typeof args.command === "string" ? args.command : "";
	// A chained or redirected command could run anything after an allowed prefix: always ask.
	if (SHELL_CHAINING.test(command)) return false;
	const wanted = pattern.split(" ");
	const tokens = commandTokens(args);
	return wanted.length > 0 && wanted.every((token, index) => tokens[index] === token);
}

interface PendingApproval {
	resolve: (outcome: ApprovalOutcome) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface ApprovalBrokerOptions {
	emit: (record: Record<string, unknown>) => void;
	timeoutMs: number;
	newId?: () => string;
	now?: () => number;
	warn?: (msg: string, fields?: Record<string, unknown>) => void;
}

export class ApprovalBroker {
	private readonly options: ApprovalBrokerOptions;
	private readonly pending = new Map<string, PendingApproval>();
	private readonly allowList: Array<{ server: string; kind: ApprovalKind; pattern: string }> = [];

	constructor(options: ApprovalBrokerOptions) {
		this.options = options;
	}

	get pendingCount(): number {
		return this.pending.size;
	}

	isAllowed(tool: ManagedToolDescriptor, args: Record<string, unknown>): boolean {
		return this.allowList.some(
			(entry) =>
				entry.server === tool.server && entry.kind === tool.kind && patternMatches(entry.pattern, tool, args),
		);
	}

	request(input: {
		toolCallId: string;
		tool: ManagedToolDescriptor;
		args: Record<string, unknown>;
		reason: string;
		agentId?: string;
	}): Promise<ApprovalOutcome> {
		const id = this.options.newId?.() ?? `apr_${randomBytes(6).toString("hex")}`;
		const now = this.options.now?.() ?? Date.now();
		const pattern = allowAlwaysPattern(input.tool, input.args);
		return new Promise<ApprovalOutcome>((resolve) => {
			const timer = setTimeout(() => this.settle(id, { decision: "expired" }), this.options.timeoutMs);
			timer.unref?.();
			this.pending.set(id, {
				timer,
				resolve: (outcome) => {
					if (outcome.decision === "allow_always") {
						this.allowList.push({ server: input.tool.server, kind: input.tool.kind, pattern });
					}
					resolve(outcome);
				},
			});
			this.options.emit({
				type: "approval_request",
				...(input.agentId ? { agent_id: input.agentId } : {}),
				id,
				tool_call_id: input.toolCallId,
				tool: { server: input.tool.server, name: input.tool.name, arguments: input.args },
				kind: input.tool.kind,
				summary: approvalSummary(input.tool, input.args),
				reason: input.reason,
				allow_always_pattern: pattern,
				expires_at: new Date(now + this.options.timeoutMs).toISOString(),
			});
		});
	}

	/** Apply an `approval_response`. False (and a warning) for an unknown or already answered id. */
	respond(message: {
		id: string;
		decision: "allow_once" | "allow_always" | "deny";
		reason?: string;
		edited_arguments?: Record<string, unknown>;
		decided_by?: { type: string; id?: string };
		type?: string;
	}): boolean {
		if (!this.pending.has(message.id)) {
			this.options.warn?.("approval response ignored: no pending request", { approval_id: message.id });
			return false;
		}
		this.settle(message.id, {
			decision: message.decision,
			reason: message.reason,
			editedArguments: message.edited_arguments,
			decidedBy: message.decided_by,
		});
		return true;
	}

	/** Resolve every pending request as `cancelled` (an `abort`, a limit stop, shutdown). */
	cancelAll(): void {
		for (const id of [...this.pending.keys()]) this.settle(id, { decision: "cancelled" });
	}

	private settle(id: string, outcome: ApprovalOutcome): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		this.options.emit({ type: "approval_resolved", id, decision: outcome.decision });
		pending.resolve(outcome);
	}
}
