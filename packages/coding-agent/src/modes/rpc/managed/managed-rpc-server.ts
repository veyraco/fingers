/**
 * Managed RPC mode (`fingers --mode rpc --managed`): the Fingers RPC v1 contract the Hands runner speaks
 * (veyraco/platform contracts/v1/fingers-rpc.md).
 *
 * The server is transport-agnostic: it reads lines through `handleLine()` and writes through `io`, so tests
 * drive it in-process. `runManagedRpcMode()` wires it to stdin, stdout and stderr.
 *
 * On top of Pi's RPC commands and session events it adds the handshake (`hello`, `configure`,
 * `credentials`), `seq` and `traceparent` correlation, structured stderr logs, the managed path policy,
 * approvals, `usage`, `file_changed`, limits and a `result` after every `agent_settled`.
 */
import type { AgentTurnDecision } from "@veyraco/fingers-agent";
import type { AssistantMessage } from "@veyraco/fingers-ai";
import type { AgentSession, AgentSessionEvent } from "../../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../../core/agent-session-runtime.ts";
import type { ExtensionAPI, InlineExtension } from "../../../core/extensions/types.ts";
import { toJsonEvent } from "../../json-event.ts";
import { ApprovalBroker, type ApprovalMode, approvalNeed, describeManagedTool } from "./approvals.ts";
import {
	CONTRACT_COMMANDS,
	CONTRACT_REPLIES,
	type ErrorCode,
	FINGERS_RPC_PROTOCOL,
	MANAGED_CAPABILITIES,
	validateCommand,
} from "./contract.ts";
import { applyCredentials, type CredentialsMessage, type ManagedMcpServer, mcpServerEntries } from "./credentials.ts";
import { FileChangeTracker } from "./file-changes.ts";
import { ManagedLogger } from "./log.ts";
import { checkManagedToolPaths, type PathPolicy, preparePathPolicy } from "./path-policy.ts";
import { SecretSet } from "./secrets.ts";
import { continueTrace } from "./trace.ts";

type JsonRecord = Record<string, any>;

export interface ManagedConfigure {
	id: string;
	type: "configure";
	run_id?: string;
	request_id?: string;
	traceparent?: string;
	workspace: { root: string; protected_paths?: string[] };
	model: { provider: string; model_id: string; thinking_level?: string };
	limits?: { max_cost_usd?: number; max_output_tokens?: number; max_duration_ms?: number; max_turns?: number };
	tools?: { builtin?: string[]; approval?: ApprovalMode };
	mcp_servers?: ManagedMcpServer[];
	approvals?: { timeout_ms?: number };
	memory?: { mode?: string };
	telemetry?: { mode?: string; capture_content?: boolean };
	checkpoints?: { dir?: string };
}

export interface ManagedRuntimeFactoryInput {
	configure: ManagedConfigure;
	/** The managed extension (path policy, approvals, MCP servers). The factory must load it. */
	extension: InlineExtension;
}

export type ManagedRuntimeFactory = (input: ManagedRuntimeFactoryInput) => Promise<AgentSessionRuntime>;

export interface ManagedRpcIo {
	/** One protocol line, LF-terminated. */
	writeStdout(line: string): void;
	/** One log line, LF-terminated. */
	writeStderr(line: string): void;
}

export interface ManagedRpcServerOptions {
	io: ManagedRpcIo;
	createRuntime: ManagedRuntimeFactory;
	version: string;
	env?: string;
	logLevel?: "debug" | "info" | "warn" | "error";
	now?: () => number;
}

type LimitStop = {
	reason: "max_cost_reached" | "max_output_tokens_reached" | "max_duration_reached" | "max_turns_reached";
	notice: string;
	failure: string;
};

interface Totals {
	tokens: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number };
	cost_usd: { input: number; output: number; cache_read: number; cache_write: number; total: number };
}

function zeroTotals(): Totals {
	return {
		tokens: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
		cost_usd: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 },
	};
}

/** Floating point sums of list prices drift in the last digits; keep 12 decimals. */
function round(value: number): number {
	return Math.round(value * 1e12) / 1e12;
}

function addTotals(into: Totals, add: Totals): void {
	for (const key of Object.keys(into.tokens) as Array<keyof Totals["tokens"]>) into.tokens[key] += add.tokens[key];
	for (const key of Object.keys(into.cost_usd) as Array<keyof Totals["cost_usd"]>) {
		into.cost_usd[key] = round(into.cost_usd[key] + add.cost_usd[key]);
	}
}

function cloneTotals(totals: Totals): Totals {
	return { tokens: { ...totals.tokens }, cost_usd: { ...totals.cost_usd } };
}

function formatUsd(value: number): string {
	return `$${Number(value.toPrecision(6))}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface RunState {
	startedAt: number;
	turns: number;
	/** The error of the turn being finished, for the `model_error` notice at its `turn_end`. */
	turnError?: string;
	/** The last model error of the run. */
	error?: string;
	limitNoticeSent: boolean;
}

export class ManagedRpcServer {
	private readonly options: ManagedRpcServerOptions;
	private readonly secrets = new SecretSet();
	private readonly logger: ManagedLogger;
	private seq = 0;
	private configureState: "none" | "configuring" | "configured" = "none";
	private configure?: ManagedConfigure;
	private runtime?: AgentSessionRuntime;
	private session?: AgentSession;
	private unsubscribe?: () => void;
	private policy?: PathPolicy;
	private fileTracker?: FileChangeTracker;
	private broker?: ApprovalBroker;
	private readonly credentials = new Map<string, { expiresAt?: string }>();
	private readonly heldStarts = new Map<string, JsonRecord>();
	private readonly cumulative = zeroTotals();
	private totalTurns = 0;
	private costUnknownNoticeSent = false;
	private firstPromptAt?: number;
	private durationTimer?: ReturnType<typeof setTimeout>;
	private limitStop?: LimitStop;
	private run?: RunState;
	private shuttingDown = false;

	constructor(options: ManagedRpcServerOptions) {
		this.options = options;
		this.logger = new ManagedLogger({
			write: (line) => options.io.writeStderr(line),
			secrets: this.secrets,
			version: options.version,
			env: options.env ?? "local",
			level: options.logLevel,
		});
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	/** Write `hello`. Call once, before the first line is handled. */
	start(): void {
		this.emit({
			type: "hello",
			protocol: FINGERS_RPC_PROTOCOL,
			fingers_version: this.options.version,
			managed: true,
			capabilities: [...MANAGED_CAPABILITIES],
		});
		this.logger.info("managed rpc started", { protocol: FINGERS_RPC_PROTOCOL });
	}

	get currentSession(): AgentSession | undefined {
		return this.session;
	}

	// =====================================================================
	// Output
	// =====================================================================

	/** Write a stdout record: every record but a `response` gets the next `seq`; secrets never leave. */
	private emit(record: JsonRecord): void {
		const { type, ...rest } = record;
		const out = type === "response" ? record : { type, seq: ++this.seq, ...rest };
		let line = JSON.stringify(out);
		if (this.secrets.containsSecret(line)) {
			this.logger.warn("secret value removed from a protocol record", { record_type: type });
			line = this.secrets.redact(line);
		}
		this.options.io.writeStdout(`${line}\n`);
	}

	private respond(id: string | undefined, command: string, data?: unknown): void {
		this.emit({
			type: "response",
			...(id === undefined ? {} : { id }),
			command,
			success: true,
			...(data === undefined ? {} : { data }),
		});
	}

	private fail(id: string | undefined, command: string, code: ErrorCode, message: string): void {
		this.emit({
			type: "response",
			...(id === undefined ? {} : { id }),
			command,
			success: false,
			error: message.slice(0, 4000) || code,
			code,
		});
		this.logger.info("command failed", { command, command_id: id, code, error: message });
	}

	private notice(level: "info" | "warn" | "error", code: string, message: string): void {
		this.emit({ type: "notice", level, code, message: message.slice(0, 2000) });
	}

	// =====================================================================
	// Input
	// =====================================================================

	async handleLine(line: string): Promise<void> {
		if (line.trim().length === 0) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			this.fail(undefined, "parse", "parse_error", `Failed to parse command: ${errorMessage(error)}`);
			return;
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed) ||
			typeof (parsed as JsonRecord).type !== "string"
		) {
			this.fail(undefined, "parse", "invalid_command", "A command is a JSON object with a string `type`");
			return;
		}
		const record = parsed as JsonRecord;
		const id = typeof record.id === "string" ? record.id : undefined;
		const type = record.type as string;

		if (CONTRACT_REPLIES.has(type)) {
			this.handleReply(record);
			return;
		}
		if (!CONTRACT_COMMANDS.has(type)) {
			this.fail(id, type, "unknown_command", `Unknown command: ${type}`);
			return;
		}
		const validation = validateCommand(record);
		if (!validation.ok) {
			this.fail(id, type, "invalid_command", `Invalid ${type}: ${validation.message}`);
			return;
		}
		const trace = continueTrace(record.traceparent);
		this.logger.setTrace(trace.context);
		if (!trace.valid)
			this.logger.warn("command without a valid traceparent; started a new trace", {
				command: type,
				command_id: id,
			});

		if (type === "configure") {
			await this.handleConfigure(record as ManagedConfigure);
			return;
		}
		if (this.configureState !== "configured" || !this.session || !this.runtime) {
			this.fail(id, type, "not_configured", "The first command must be configure");
			return;
		}
		try {
			await this.handleCommand(type, id, record);
		} catch (error) {
			this.logger.error("command failed unexpectedly", { command: type, command_id: id, err: error });
			this.fail(id, type, "internal", errorMessage(error));
		}
	}

	private handleReply(record: JsonRecord): void {
		if (record.type === "approval_response") {
			const validation = validateCommand(record);
			if (!validation.ok) {
				this.logger.warn("invalid approval_response ignored", {
					approval_id: record.id,
					error: validation.message,
				});
				return;
			}
			if (!this.broker) {
				this.logger.warn("approval_response before configure ignored", { approval_id: record.id });
				return;
			}
			this.broker.respond(record as Parameters<ApprovalBroker["respond"]>[0]);
			return;
		}
		// memory_response arrives with the memory relay (not announced yet); extension UI is answered locally.
		this.logger.warn("reply ignored", { reply_type: record.type, reply_id: record.id });
	}

	// =====================================================================
	// configure
	// =====================================================================

	private async handleConfigure(configure: ManagedConfigure): Promise<void> {
		if (this.configureState !== "none") {
			this.fail(configure.id, "configure", "already_configured", "configure was already sent");
			return;
		}
		this.configureState = "configuring";
		this.logger.setRun({ runId: configure.run_id, requestId: configure.request_id });
		try {
			for (const server of configure.mcp_servers ?? []) {
				for (const value of Object.values(server.headers ?? {})) this.secrets.add(value);
			}
			this.policy = await preparePathPolicy({
				workspaceRoot: configure.workspace.root,
				protectedPaths: configure.workspace.protected_paths ?? [],
			});
			this.configure = configure;
			this.fileTracker = new FileChangeTracker(this.policy.workspace.logical);
			this.broker = new ApprovalBroker({
				emit: (record) => this.emit(record),
				timeoutMs: configure.approvals?.timeout_ms ?? 30 * 60 * 1000,
				now: () => this.now(),
				warn: (msg, fields) => this.logger.warn(msg, fields),
			});
			this.runtime = await this.options.createRuntime({ configure, extension: this.createManagedExtension() });
			this.runtime.setRebindSession(async () => {
				await this.bindSession();
			});
			await this.bindSession();
			if (!this.session?.model)
				throw new Error(`Unknown model: ${configure.model.provider}/${configure.model.model_id}`);
		} catch (error) {
			this.configureState = "none";
			this.configure = undefined;
			this.logger.error("configure failed", { err: error });
			this.fail(configure.id, "configure", "invalid_command", `configure failed: ${errorMessage(error)}`);
			await this.runtime?.dispose().catch(() => {});
			this.runtime = undefined;
			this.session = undefined;
			return;
		}
		this.configureState = "configured";
		this.logger.info("configured", {
			workspace: this.policy.workspace.logical,
			provider: configure.model.provider,
			model: configure.model.model_id,
			approval: configure.tools?.approval ?? "write_tools",
			mcp_servers: (configure.mcp_servers ?? []).map((server) => server.name),
			session_id: this.session.sessionId,
		});
		this.respond(configure.id, "configure", { session_id: this.session.sessionId });
	}

	private createManagedExtension(): InlineExtension {
		return {
			name: "veyra-managed",
			hidden: true,
			factory: (fingers: ExtensionAPI) => {
				for (const { name, config } of mcpServerEntries(this.configure?.mcp_servers ?? [])) {
					fingers.registerMcpServer(name, config);
				}
				fingers.on("tool_call", async (event) => {
					try {
						return await this.gateToolCall(
							event.toolName,
							event.toolCallId,
							event.input as JsonRecord,
							event.parentToolCallId,
						);
					} finally {
						this.releaseHeldStart(event.toolCallId);
					}
				});
			},
		};
	}

	/** Path policy, then approval; null result lets the call run. */
	private async gateToolCall(
		toolName: string,
		toolCallId: string,
		input: JsonRecord,
		parentToolCallId: string | undefined,
	): Promise<{ block: true; reason: string } | undefined> {
		const configure = this.configure!;
		const policy = this.policy!;
		const blocked = await checkManagedToolPaths(toolName, input, policy);
		if (blocked) {
			this.logger.warn("tool call blocked by the managed path policy", {
				tool: toolName,
				tool_call_id: toolCallId,
				reason: blocked,
			});
			return { block: true, reason: blocked };
		}
		const servers = (configure.mcp_servers ?? []).map((server) => server.name);
		const tool = describeManagedTool(toolName, servers);
		const serverMode = configure.mcp_servers?.find((server) => server.name === tool.server)?.approval;
		const mode: ApprovalMode =
			(tool.kind === "mcp_tool" ? serverMode : undefined) ?? configure.tools?.approval ?? "write_tools";
		const need = approvalNeed(tool, mode);
		if (need.required && !this.broker!.isAllowed(tool, input)) {
			const outcome = await this.broker!.request({ toolCallId, tool, args: input, reason: need.reason });
			this.logger.info("approval resolved", {
				tool: toolName,
				tool_call_id: toolCallId,
				decision: outcome.decision,
				decided_by_type: outcome.decidedBy?.type,
				decided_by_id: outcome.decidedBy?.id,
			});
			try {
				this.session?.sessionManager.appendCustomEntry("veyra.approval", {
					tool_call_id: toolCallId,
					tool: { server: tool.server, name: tool.name },
					decision: outcome.decision,
					...(outcome.decidedBy ? { decided_by: outcome.decidedBy } : {}),
				});
			} catch (error) {
				this.logger.warn("approval not recorded in the session", { err: error });
			}
			if (outcome.decision !== "allow_once" && outcome.decision !== "allow_always") {
				const reason =
					outcome.reason?.trim() ||
					(outcome.decision === "expired"
						? "the approval request expired"
						: outcome.decision === "cancelled"
							? "the run was stopped"
							: "not approved");
				return { block: true, reason: `Denied: ${reason}` };
			}
			if (outcome.editedArguments) {
				for (const key of Object.keys(input)) delete input[key];
				Object.assign(input, outcome.editedArguments);
			}
			// The workspace may have changed while a person decided: check the paths again.
			const again = await checkManagedToolPaths(toolName, input, policy);
			if (again) {
				this.logger.warn("tool call blocked by the managed path policy after approval", {
					tool: toolName,
					tool_call_id: toolCallId,
					reason: again,
				});
				return { block: true, reason: again };
			}
		}
		if (!parentToolCallId) this.fileTracker!.before(toolCallId, toolName, input);
		return undefined;
	}

	private releaseHeldStart(toolCallId: string): void {
		const held = this.heldStarts.get(toolCallId);
		if (!held) return;
		this.heldStarts.delete(toolCallId);
		this.emit(held);
	}

	private async bindSession(): Promise<void> {
		const runtime = this.runtime!;
		const session = runtime.session;
		this.session = session;
		// Secrets a provider echoes (an error body, a header) must not reach the session file either.
		session.sessionManager.setSerializedEntryFilter((line) => this.secrets.redact(line));
		this.unsubscribe?.();
		this.unsubscribe = session.subscribe((event) => this.onSessionEvent(event));
		const agent = session.agent;
		const previousFinishTurn = agent.finishTurn;
		agent.finishTurn = async (turn, signal): Promise<AgentTurnDecision | undefined> => {
			const decision = (await previousFinishTurn?.(turn, signal)) ?? undefined;
			// A limit reached during this turn ends the run after the turn's tool calls.
			if (this.limitStop) return { action: "end" };
			return decision;
		};
		await session.bindExtensions({
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (options) => runtime.newSession(options),
				fork: async (entryId, forkOptions) => {
					const result = await runtime.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => runtime.switchSession(sessionPath, options),
				reload: async () => {
					await session.reload();
				},
			},
			shutdownHandler: () => {
				void this.shutdown("extension");
			},
			onError: (err) => {
				this.emit({
					type: "extension_error",
					extensionPath: err.extensionPath,
					event: err.event,
					error: err.error,
				});
			},
		});
		for (const diagnostic of runtime.takeUnreportedDiagnostics()) {
			this.logger.log(diagnostic.type === "error" ? "error" : "warn", "runtime diagnostic", {
				diagnostic: diagnostic.message,
			});
		}
	}

	// =====================================================================
	// Session events
	// =====================================================================

	private onSessionEvent(event: AgentSessionEvent): void {
		const record = toJsonEvent(event) as JsonRecord;
		switch (event.type) {
			case "agent_start":
				if (!this.run) this.run = { startedAt: this.now(), turns: 0, limitNoticeSent: false };
				this.emit(record);
				return;
			case "tool_execution_start":
				// Held until the managed gate decided, so an approval_request comes before the call starts.
				this.heldStarts.set(event.toolCallId, record);
				return;
			case "tool_execution_end": {
				this.releaseHeldStart(event.toolCallId);
				this.emit(record);
				if (event.isError) {
					this.fileTracker?.discard(event.toolCallId);
					return;
				}
				try {
					const change = this.fileTracker?.after(event.toolCallId);
					if (change) this.emit({ type: "file_changed", ...change, tool_call_id: event.toolCallId });
				} catch (error) {
					this.logger.warn("file change not computed", { err: error });
				}
				return;
			}
			case "message_end":
				this.emit(record);
				if (event.message.role === "assistant") this.onAssistantMessage(event.message as AssistantMessage);
				return;
			case "turn_end":
				this.emit(record);
				if (this.run?.turnError) {
					this.notice("error", "model_error", `The model provider returned an error: ${this.run.turnError}`);
					this.run.turnError = undefined;
				}
				if (this.limitStop && this.run && !this.run.limitNoticeSent) {
					this.run.limitNoticeSent = true;
					this.notice("warn", "limit_reached", this.limitStop.notice);
				}
				return;
			case "agent_settled":
				this.onAgentSettled(record);
				return;
			default:
				this.emit(record);
		}
	}

	private onAssistantMessage(message: AssistantMessage): void {
		if (!this.run) this.run = { startedAt: this.now(), turns: 0, limitNoticeSent: false };
		const run = this.run;
		run.turns++;
		this.totalTurns++;
		if (message.stopReason === "error") {
			const text = message.errorMessage ?? "unknown error";
			run.turnError = text;
			run.error = text;
		}
		const usage = message.usage;
		const turn: Totals = {
			tokens: {
				input_tokens: usage?.input ?? 0,
				output_tokens: usage?.output ?? 0,
				cache_read_tokens: usage?.cacheRead ?? 0,
				cache_write_tokens: usage?.cacheWrite ?? 0,
			},
			cost_usd: {
				input: usage?.cost?.input ?? 0,
				output: usage?.cost?.output ?? 0,
				cache_read: usage?.cost?.cacheRead ?? 0,
				cache_write: usage?.cost?.cacheWrite ?? 0,
				total: usage?.cost?.total ?? 0,
			},
		};
		const tokenCount = Object.values(turn.tokens).reduce((sum, value) => sum + value, 0);
		if (tokenCount === 0 && (message.stopReason === "error" || message.stopReason === "aborted")) {
			this.checkLimits();
			return;
		}
		const model = this.session?.modelRuntime.getModel(message.provider, message.model);
		const priced = Boolean(model && (model.cost.input > 0 || model.cost.output > 0));
		addTotals(this.cumulative, turn);
		this.emit({
			type: "usage",
			provider: message.provider,
			model: message.model,
			...(message.responseId ? { response_id: message.responseId } : {}),
			turn,
			cost_source: priced ? "list_price" : "unknown",
			cumulative: cloneTotals(this.cumulative),
		});
		if (!priced && !this.costUnknownNoticeSent) {
			this.costUnknownNoticeSent = true;
			const capNote =
				this.configure?.limits?.max_cost_usd !== undefined ? " max_cost_usd cannot stop this run." : "";
			this.notice(
				"warn",
				"cost_unknown",
				`No list price is known for ${message.provider}/${message.model}.${capNote}`,
			);
		}
		this.checkLimits(priced);
	}

	private checkLimits(priced = true): void {
		if (this.limitStop) return;
		const limits = this.configure?.limits;
		if (!limits) return;
		if (priced && limits.max_cost_usd !== undefined && this.cumulative.cost_usd.total >= limits.max_cost_usd) {
			this.tripLimit({
				reason: "max_cost_reached",
				notice: `Stopped: max cost reached (${formatUsd(this.cumulative.cost_usd.total)} of ${formatUsd(limits.max_cost_usd)}).`,
				failure: "Stopped: max cost reached",
			});
		} else if (
			limits.max_output_tokens !== undefined &&
			this.cumulative.tokens.output_tokens >= limits.max_output_tokens
		) {
			this.tripLimit({
				reason: "max_output_tokens_reached",
				notice: `Stopped: max output tokens reached (${this.cumulative.tokens.output_tokens} of ${limits.max_output_tokens}).`,
				failure: "Stopped: max output tokens reached",
			});
		} else if (limits.max_turns !== undefined && this.totalTurns >= limits.max_turns) {
			this.tripLimit({
				reason: "max_turns_reached",
				notice: `Stopped: max turns reached (${this.totalTurns} of ${limits.max_turns}).`,
				failure: "Stopped: max turns reached",
			});
		}
	}

	private tripLimit(stop: LimitStop): void {
		this.limitStop = stop;
		this.logger.warn("limit reached", {
			stop_reason: stop.reason,
			cost_usd: this.cumulative.cost_usd.total,
			turns: this.totalTurns,
		});
		// Approvals waiting now would only delay the stop.
		this.broker?.cancelAll();
	}

	private onAgentSettled(record: JsonRecord): void {
		const run = this.run;
		this.run = undefined;
		let status: "completed" | "cancelled" | "stopped" | "failed";
		let stopReason: string;
		let failure: { code: string; message: string } | null = null;
		if (this.limitStop) {
			status = "stopped";
			stopReason = this.limitStop.reason;
			failure = {
				code: this.limitStop.reason === "max_turns_reached" ? "agent_error" : this.limitStop.reason,
				message: this.limitStop.failure,
			};
		} else if (record.aborted) {
			status = "cancelled";
			stopReason = "aborted";
			failure = { code: "cancelled_by_actor", message: "Cancelled by the host" };
		} else if (run?.error) {
			status = "failed";
			stopReason = this.credentialsExpired() ? "credentials_expired" : "model_error";
			failure = { code: "model_error", message: `The model provider returned an error: ${run.error}` };
		} else {
			status = "completed";
			stopReason = "completed";
		}
		// The contract ties agent_settled.aborted to the outcome: true exactly for cancelled and stopped.
		this.emit({ ...record, aborted: status === "cancelled" || status === "stopped" });
		const result = {
			type: "result",
			agent_id: "main",
			status,
			stop_reason: stopReason,
			failure,
			session_id: this.session?.sessionId ?? "",
			text: this.session?.getLastAssistantText() ?? null,
			usage: cloneTotals(this.cumulative),
			duration_ms: run ? Math.max(0, this.now() - run.startedAt) : 0,
			turns: run?.turns ?? 0,
		};
		this.emit(result);
		this.logger.info("run settled", {
			status,
			stop_reason: stopReason,
			turns: result.turns,
			duration_ms: result.duration_ms,
			cost_usd: this.cumulative.cost_usd.total,
		});
	}

	private credentialsExpired(): boolean {
		const provider = this.session?.model?.provider;
		const expiresAt = provider ? this.credentials.get(provider)?.expiresAt : undefined;
		return expiresAt !== undefined && Date.parse(expiresAt) <= this.now();
	}

	// =====================================================================
	// Commands
	// =====================================================================

	private async handleCommand(type: string, id: string | undefined, command: JsonRecord): Promise<void> {
		const session = this.session!;
		const runtime = this.runtime!;
		switch (type) {
			case "credentials": {
				const message = command as unknown as CredentialsMessage;
				await applyCredentials(session.modelRuntime, message, this.secrets);
				// The session holds the model object composed before the provider got its base URL: refresh it.
				const current = session.model;
				if (current?.provider === message.provider) {
					const refreshed = session.modelRuntime.getModel(current.provider, current.id);
					if (refreshed) session.agent.state.model = refreshed;
				}
				this.credentials.set(message.provider, { expiresAt: message.expires_at });
				this.logger.info("credentials received", {
					provider: message.provider,
					credential_kind: message.credential_kind,
					expires_at: message.expires_at,
				});
				this.respond(id, "credentials", {
					provider: message.provider,
					...(message.expires_at ? { expires_at: message.expires_at } : {}),
				});
				return;
			}
			case "prompt": {
				const provider = session.model?.provider;
				if (!provider || !this.credentials.has(provider)) {
					this.fail(
						id,
						"prompt",
						"credentials_missing",
						`No credentials for ${provider ?? "the configured provider"}`,
					);
					return;
				}
				if (session.isStreaming && !command.streamingBehavior) {
					this.fail(id, "prompt", "busy", "A run is active: send streamingBehavior steer or followUp");
					return;
				}
				this.startDurationLimit();
				let answered = false;
				this.logger.info("prompt received", { command_id: id });
				void session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
						preflightResult: (disposition) => {
							answered = true;
							this.respond(id, "prompt", { disposition });
						},
					})
					.catch((error) => {
						if (!answered) this.fail(id, "prompt", "internal", errorMessage(error));
						else this.logger.error("prompt failed after it started", { err: error });
					});
				return;
			}
			case "steer":
			case "follow_up": {
				if (command.agent_id && command.agent_id !== "main") {
					this.fail(id, type, "not_found", `No agent ${command.agent_id}`);
					return;
				}
				const disposition =
					type === "steer"
						? await session.steer(command.message, command.images, { source: "rpc" })
						: await session.followUp(command.message, command.images, { source: "rpc" });
				this.logger.info("message queued", { kind: type, message_id: command.message_id, disposition });
				this.respond(id, type, { disposition });
				return;
			}
			case "abort": {
				if (command.agent_id && command.agent_id !== "main") {
					this.fail(id, "abort", "not_found", `No agent ${command.agent_id}`);
					return;
				}
				this.broker?.cancelAll();
				await session.abort();
				this.respond(id, "abort");
				return;
			}
			case "clear_queue":
				this.respond(id, "clear_queue", session.clearQueue());
				return;
			case "compact":
				this.respond(id, "compact", await session.compact(command.customInstructions));
				return;
			case "fork": {
				const result = await runtime.fork(command.entryId);
				this.respond(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
				return;
			}
			case "clone": {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) {
					this.fail(id, "clone", "not_found", "Cannot clone session: no current entry selected");
					return;
				}
				const result = await runtime.fork(leafId, { position: "at" });
				this.respond(id, "clone", { cancelled: result.cancelled });
				return;
			}
			case "get_state":
				this.respond(id, "get_state", {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
				});
				return;
			case "get_messages":
				this.respond(id, "get_messages", { messages: session.messages });
				return;
			case "get_last_assistant_text":
				this.respond(id, "get_last_assistant_text", { text: session.getLastAssistantText() });
				return;
			case "get_session_stats":
				this.respond(id, "get_session_stats", session.getSessionStats());
				return;
			case "set_model": {
				const model = session.modelRuntime.getModel(command.provider, command.modelId);
				if (!model) {
					this.fail(id, "set_model", "not_found", `Model not found: ${command.provider}/${command.modelId}`);
					return;
				}
				if (!this.credentials.has(model.provider)) {
					this.fail(id, "set_model", "credentials_missing", `No credentials for ${model.provider}`);
					return;
				}
				await session.setModel(model);
				this.respond(id, "set_model", model);
				return;
			}
			case "set_thinking_level":
				session.setThinkingLevel(command.level);
				this.respond(id, "set_thinking_level");
				return;
			case "checkpoint_export":
			case "checkpoint_import":
				this.fail(
					id,
					type,
					"unsupported",
					"Checkpoints are not available in this Fingers version (no `checkpoints` capability)",
				);
				return;
			default:
				this.fail(id, type, "unknown_command", `Unknown command: ${type}`);
		}
	}

	private startDurationLimit(): void {
		if (this.firstPromptAt !== undefined) return;
		this.firstPromptAt = this.now();
		const maxMs = this.configure?.limits?.max_duration_ms;
		if (maxMs === undefined) return;
		this.durationTimer = setTimeout(() => {
			if (this.limitStop) return;
			this.tripLimit({
				reason: "max_duration_reached",
				notice: `Stopped: max duration reached (${maxMs} ms).`,
				failure: "Stopped: max duration reached",
			});
			if (this.run) this.run.limitNoticeSent = true;
			this.notice("warn", "limit_reached", this.limitStop!.notice);
			void this.session?.abort();
		}, maxMs);
		this.durationTimer.unref?.();
	}

	/** Orderly shutdown: abort running work, write the session, release resources. */
	async shutdown(reason: string): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		this.logger.info("shutting down", { reason });
		if (this.durationTimer) clearTimeout(this.durationTimer);
		this.broker?.cancelAll();
		try {
			if (this.session && !this.session.isIdle) await this.session.abort();
		} catch (error) {
			this.logger.warn("abort during shutdown failed", { err: error });
		}
		this.unsubscribe?.();
		await this.runtime?.dispose().catch((error) => this.logger.warn("dispose failed", { err: error }));
	}
}
