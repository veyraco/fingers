/**
 * Managed RPC mode (`fingers --mode rpc --managed`): the Fingers RPC v1 contract the Hands runner speaks
 * (veyraco/platform contracts/v1/fingers-rpc.md).
 *
 * The server is transport-agnostic: it reads lines through `handleLine()` and writes through `io`, so tests
 * drive it in-process. `runManagedRpcMode()` wires it to stdin, stdout and stderr.
 *
 * On top of Pi's RPC commands and session events it adds the handshake (`hello`, `configure`,
 * `credentials`), `seq` and `traceparent` correlation, structured stderr logs, the managed path policy,
 * approvals, `usage`, `file_changed`, limits, checkpoints, the memory and telemetry relays and a `result` after
 * every `agent_settled`.
 *
 * With `configure.subagents.enabled` (F18b) the agent gets the `agents` tool of the ee sub-agent engine
 * (./subagents.ts): each child runs under the same gate (path policy on its worktree, approvals, the run's tools,
 * correlation headers, telemetry relay), its records are forwarded with its `agent_id`, its usage counts toward the
 * run's limits, and `steer`, `abort` and checkpoints can name it.
 */
import { randomUUID } from "node:crypto";
import { join, relative, sep } from "node:path";
import type { AssistantMessage, ProviderHeaders } from "@veyraco/fingers-ai";
import type { AgentSession, AgentSessionEvent } from "../../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../../core/agent-session-runtime.ts";
import { findBrowserExecutable } from "../../../core/browser/browser-session.ts";
import { HostPolicy, type NetworkConfig } from "../../../core/browser/host-policy.ts";
import { costCapReached, endRunAfterTurnWhen, isListPriced } from "../../../core/budget.ts";
import type { ExtensionAPI, InlineExtension } from "../../../core/extensions/types.ts";
import {
	createMemoryExtension,
	DEFAULT_MEMORY_CONTEXT_TOKENS,
	MEMORY_CONTEXT_ENTRY,
} from "../../../core/memory/extension.ts";
import { type MemoryResponseRecord, RelayMemoryProvider } from "../../../core/memory/relay.ts";
import type { MemoryUnavailableError } from "../../../core/memory/types.ts";
import { SessionManager } from "../../../core/session-manager.ts";
import { DEFAULT_TOOL_NAMES } from "../../../core/settings-manager.ts";
import { SubagentEngines } from "../../../core/subagents/registry.ts";
import type { SubagentEngine, SubagentEvent, SubagentStatus } from "../../../core/subagents/types.ts";
import { childSpan, continueTrace, formatTraceparent, type TraceContext } from "../../../core/trace-context.ts";
import type { SpanExporter } from "../../../core/tracing/spans.ts";
import { SessionTracer } from "../../../core/tracing/tracer.ts";
import { BROWSER_TOOL_NAME, createBrowserExtension } from "../../../extensions/browser/index.ts";
import type {
	ChildGateContext,
	ChildIdentity,
	ChildSessionHooks,
} from "../../../extensions/subagents/child-session.ts";
import { AGENTS_TOOL, createSubagentsExtension } from "../../../extensions/subagents/index.ts";
import { toJsonEvent } from "../../json-event.ts";
import { ApprovalBroker, type ApprovalMode, approvalNeed, approvalSummary, describeManagedTool } from "./approvals.ts";
import {
	branchMessageCount,
	CHECKPOINT_FORMAT,
	CheckpointError,
	checkpointId,
	readCheckpointFile,
	resolveCheckpointPath,
	serializeCheckpoint,
	storeImportedSession,
	writeCheckpointFile,
} from "./checkpoints.ts";
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
import { checkManagedToolPaths, inside, type PathPolicy, physicalPath, preparePathPolicy } from "./path-policy.ts";
import { SecretSet, secretHeaderValues } from "./secrets.ts";
import { workspaceBoundEngine } from "./subagents.ts";

type JsonRecord = Record<string, any>;

/** Commands that start model work: when the agent is idle, the run they start continues their trace. */
const WORK_COMMANDS = new Set(["prompt", "steer", "follow_up", "compact"]);

/** Correlation headers Fingers sets on model requests; a provider or host value with any casing is replaced. */
const CORRELATION_HEADER = /^(traceparent|x-request-id)$/i;

/** `veyra.correlation_id` (contracts/v1/eyes-feed.md): the run's X-Request-Id when it has this shape. */
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface ManagedConfigure {
	id: string;
	type: "configure";
	run_id?: string;
	request_id?: string;
	traceparent?: string;
	workspace: { root: string; protected_paths?: string[] };
	model: { provider: string; model_id: string; thinking_level?: string };
	/** The host's instructions (Hands: RunTask.instructions), added verbatim to the end of Fingers' system prompt. */
	system_prompt?: string;
	limits?: { max_cost_usd?: number; max_output_tokens?: number; max_duration_ms?: number; max_turns?: number };
	tools?: { builtin?: string[]; approval?: ApprovalMode };
	mcp_servers?: ManagedMcpServer[];
	/** Hosts the traffic Fingers carries itself (the browser tool) may reach. Absent: `open`. */
	network?: NetworkConfig;
	approvals?: { timeout_ms?: number };
	/** `relay`: the memory provider asks the host (`memory_request`); `off` (default): no memory. */
	memory?: { mode?: string; context_budget_tokens?: number };
	/** `relay`: finished spans go to the host as `telemetry_span`; `off` (default): no spans. */
	telemetry?: { mode?: string; capture_content?: boolean };
	checkpoints?: { dir?: string };
	/** `enabled`: the agent gets the `agents` tool (F18b); the host decided the organization may use sub-agents. */
	subagents?: { enabled: boolean };
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
	/**
	 * The sub-agent engine of this build (the ee module, ./subagents.ts), or undefined when it has none: then `hello`
	 * does not announce `subagents` and `configure.subagents.enabled` is refused. `checkpointsOn` says whether the run
	 * configured checkpoints.
	 */
	subagentEngine?: (checkpointsOn: () => boolean) => SubagentEngine | undefined;
}

/** A `configure` failure with its own error code. */
class ConfigureError extends Error {
	readonly code: ErrorCode;

	constructor(code: ErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

/** The agent a tool call or a model request belongs to: the main agent or a sub-agent (F18b). */
interface GateAgent {
	/** `main` or `sub_…`. */
	id: string;
	policy(): Promise<PathPolicy>;
	tracker: FileChangeTracker;
	session(): AgentSession | undefined;
	/** A sub-agent: tell its engine it waits for an approval. */
	waiting?(waiting: boolean, request?: { command: string; reason: string }): void;
	/** A sub-agent: aborted when it stops, which cancels its pending approval. */
	signal?(): AbortSignal;
}

/** A sub-agent's session as managed mode watches it. */
interface ChildState extends ChildIdentity {
	session?: AgentSession;
	tracker: FileChangeTracker;
	policy?: Promise<PathPolicy>;
	tracer?: SessionTracer;
}

/** The key a held `tool_execution_start` waits under: tool call ids are only unique within one agent's session. */
function holdKey(agentId: string, toolCallId: string): string {
	return agentId === "main" ? toolCallId : `${agentId}\u0000${toolCallId}`;
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

/** An agent's usage (the core's Usage) as the contract's totals. */
function usageTotals(usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}): Totals {
	return {
		tokens: {
			input_tokens: usage.input,
			output_tokens: usage.output,
			cache_read_tokens: usage.cacheRead,
			cache_write_tokens: usage.cacheWrite,
		},
		cost_usd: {
			input: round(usage.cost.input),
			output: round(usage.cost.output),
			cache_read: round(usage.cost.cacheRead),
			cache_write: round(usage.cost.cacheWrite),
			total: round(usage.cost.total),
		},
	};
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
	/** The memory relay (`memory.mode: relay`): Fingers never calls Brain, the host does. */
	private memory?: RelayMemoryProvider;
	private memoryNoticeSent = false;
	/** The telemetry relay (`telemetry.mode: relay`): spans go to the host, Fingers sends none itself. */
	private tracer?: SessionTracer;
	private unsubscribeTracer?: () => void;
	private readonly credentials = new Map<string, { expiresAt?: string }>();
	/**
	 * The latest `credentials` message per provider, in memory only. A session replacement (fork, clone,
	 * checkpoint import) builds a new model runtime, which gets them again.
	 */
	private readonly credentialMessages = new Map<string, CredentialsMessage>();
	private readonly heldStarts = new Map<string, JsonRecord>();
	private readonly cumulative = zeroTotals();
	private totalTurns = 0;
	private costUnknownNoticeSent = false;
	private firstPromptAt?: number;
	private durationTimer?: ReturnType<typeof setTimeout>;
	private limitStop?: LimitStop;
	private run?: RunState;
	private shuttingDown = false;
	/** The trace of the latest command. */
	private commandTrace?: TraceContext;
	/** The trace of the command that started the current (or last) run: model requests are its child spans. */
	private workTrace?: TraceContext;
	private compactionStartedAt?: number;
	/** This build's sub-agent engine (ee); undefined: no sub-agents. */
	private readonly subagentEngine?: SubagentEngine;
	/** The engine while this run has sub-agents on (`configure.subagents.enabled`). */
	private subagents?: SubagentEngines;
	private unsubscribeSubagents?: () => void;
	/** Sub-agents whose session is live, by id. */
	private readonly children = new Map<string, ChildState>();
	/** The last status announced per sub-agent (`subagent_updated` only on a change). */
	private readonly subagentStatus = new Map<string, SubagentStatus>();
	/** The repository root the sub-agents' worktrees are relative to (resolved), once a call ran. */
	private repositoryRoot?: string;
	/** Sub-agent checkpoints this process wrote, by SHA-256 (they restore only here). */
	private readonly subagentCheckpoints = new Map<string, { agentId: string; checkpoint: string; entryId: string }>();
	/** One checkpoint export or import per sub-agent at a time. */
	private readonly subagentLocks = new Map<string, Promise<unknown>>();

	constructor(options: ManagedRpcServerOptions) {
		this.options = options;
		this.subagentEngine = options.subagentEngine?.(() => this.configure?.checkpoints?.dir !== undefined);
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
			capabilities: [
				...MANAGED_CAPABILITIES,
				...(findBrowserExecutable() ? ["browser"] : []),
				...(this.subagentEngine ? ["subagents"] : []),
			],
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
			// Values only: the record stays valid JSON with the same structure.
			line = this.secrets.redactJsonLine(line);
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
		this.commandTrace = trace.context;
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
		// A command that joins a running run (a steer, a queued prompt) leaves the run on its own trace.
		if (WORK_COMMANDS.has(type) && !this.session.isStreaming) this.workTrace = trace.context;
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
		if (record.type === "memory_response") {
			const validation = validateCommand(record);
			if (!validation.ok) {
				this.logger.warn("invalid memory_response ignored", {
					memory_request_id: record.id,
					error: validation.message,
				});
				return;
			}
			if (!this.memory?.respond(record as MemoryResponseRecord)) {
				this.logger.warn("memory_response for no waiting request ignored", { memory_request_id: record.id });
			}
			return;
		}
		// Extension UI is answered locally.
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
				for (const value of secretHeaderValues(server.headers)) this.secrets.add(value);
			}
			// Throws on a host pattern the policy cannot use, before anything starts.
			new HostPolicy(configure.network);
			if (configure.tools?.builtin?.includes(BROWSER_TOOL_NAME) && !findBrowserExecutable()) {
				throw new Error(
					"tools.builtin names browser, but no Chromium-based browser was found (FINGERS_BROWSER_PATH or a standard install)",
				);
			}
			if (configure.subagents?.enabled && !this.subagentEngine) {
				throw new ConfigureError(
					"unsupported",
					"subagents.enabled, but this Fingers has no sub-agents (hello did not announce subagents)",
				);
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
				shellPath: () => this.session?.settingsManager.getShellPath(),
			});
			if (configure.memory?.mode === "relay") {
				this.memory = new RelayMemoryProvider({
					// The run's memory only: a checkpoint of another run (or of a session without a run id) keeps no
					// context this run reuses.
					key: configure.run_id ? `hands-run:${configure.run_id}` : `hands-configure:${randomUUID()}`,
					emit: (request) => {
						this.logger.info("memory request", { memory_request_id: request.id, op: request.op });
						this.emit(request);
					},
				});
			}
			if (configure.telemetry?.mode === "relay") {
				this.tracer = this.createRelayTracer(configure, "main", () => this.session);
			}
			if (configure.subagents?.enabled && this.subagentEngine) {
				const engines = new SubagentEngines();
				engines.set(
					workspaceBoundEngine(
						this.subagentEngine,
						() => this.policy!.workspace.physical,
						(root) => {
							this.repositoryRoot = root;
						},
					),
					() => true,
				);
				this.unsubscribeSubagents = engines.onEvent((event) => this.onSubagentEvent(event));
				this.subagents = engines;
			}
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
			this.memory?.close();
			this.memory = undefined;
			this.unsubscribeTracer?.();
			this.unsubscribeTracer = undefined;
			this.tracer = undefined;
			this.unsubscribeSubagents?.();
			this.unsubscribeSubagents = undefined;
			this.subagents = undefined;
			this.logger.error("configure failed", { err: error });
			this.fail(
				configure.id,
				"configure",
				error instanceof ConfigureError ? error.code : "invalid_command",
				`configure failed: ${errorMessage(error)}`,
			);
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
			// The instructions themselves are never logged.
			system_prompt_chars: configure.system_prompt?.length ?? 0,
			approval: configure.tools?.approval ?? "write_tools",
			mcp_servers: (configure.mcp_servers ?? []).map((server) => server.name),
			builtin_tools: configure.tools?.builtin,
			network_mode: configure.network?.mode ?? "open",
			memory_mode: this.memory ? "relay" : "off",
			telemetry_mode: this.tracer ? "relay" : "off",
			telemetry_capture_content: this.tracer ? configure.telemetry?.capture_content === true : undefined,
			subagents: this.subagents !== undefined,
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
				if (this.configure?.tools?.builtin?.includes(BROWSER_TOOL_NAME)) {
					createBrowserExtension({
						network: this.configure.network,
						log: (level, msg, fields) => this.logger[level](msg, fields),
					})(fingers);
				}
				const memory = this.memory;
				if (memory) {
					createMemoryExtension({
						provider: async () => memory,
						contextBudgetTokens: this.configure?.memory?.context_budget_tokens ?? DEFAULT_MEMORY_CONTEXT_TOKENS,
						onUnavailable: (error) => this.onMemoryUnavailable(error),
						ref: (ctx) =>
							this.configure?.run_id
								? { app: "hands", type: "run", id: this.configure.run_id }
								: { app: "fingers", type: "session", id: ctx.sessionManager.getSessionId() },
					})(fingers);
				}
				if (this.subagents) {
					const server = this;
					createSubagentsExtension({
						engines: this.subagents,
						limitReached: () => this.limitStop !== undefined,
						child: this.childHooks(),
						// The children read the same global instructions as the main agent.
						get agentDir() {
							return server.runtime?.services.agentDir;
						},
					})(fingers);
				}
				fingers.on("before_provider_headers", (event) => {
					this.addCorrelationHeaders(event.headers, this.tracer);
				});
				fingers.on("tool_call", async (event) => {
					try {
						return await this.gateToolCall(
							event.toolName,
							event.toolCallId,
							event.input as JsonRecord,
							event.parentToolCallId,
							this.mainAgent(),
						);
					} finally {
						this.releaseHeldStart(event.toolCallId);
					}
				});
			},
		};
	}

	private mainAgent(): GateAgent {
		return {
			id: "main",
			policy: async () => this.policy!,
			tracker: this.fileTracker!,
			session: () => this.session,
		};
	}

	// =====================================================================
	// Sub-agents (F18b)
	// =====================================================================

	/** The run's built-in tools for a child: no browser, memory or agents of its own (and no MCP servers). */
	private childToolNames(): string[] {
		const tools = this.configure?.tools?.builtin ?? DEFAULT_TOOL_NAMES;
		return tools.filter((name) => name !== BROWSER_TOOL_NAME && name !== AGENTS_TOOL && !name.startsWith("memory_"));
	}

	private childHooks(): ChildSessionHooks {
		return {
			tools: this.childToolNames(),
			noSkills: true,
			extensions: (child) => [this.createChildExtension(child)],
			attach: (child, session) => this.attachChild(child, session),
		};
	}

	private childState(child: ChildIdentity): ChildState {
		let state = this.children.get(child.id);
		if (!state) {
			state = { id: child.id, label: child.label, cwd: child.cwd, tracker: new FileChangeTracker(child.cwd) };
			this.children.set(child.id, state);
		}
		return state;
	}

	/**
	 * A child's path policy: the workspace rules on its worktree (its copy of `workspace.root`), which must itself lie
	 * inside the workspace.
	 */
	private childPolicy(state: ChildState): Promise<PathPolicy> {
		state.policy ??= (async () => {
			const policy = await preparePathPolicy({
				workspaceRoot: state.cwd,
				protectedPaths: this.configure?.workspace.protected_paths ?? [],
			});
			const workspace = this.policy!.workspace.physical;
			if (!inside(workspace, policy.workspace.physical) || !inside(workspace, await physicalPath(state.cwd))) {
				throw new Error("The sub-agent's worktree is outside the workspace");
			}
			return policy;
		})();
		return state.policy;
	}

	/** The gate of a child's tool calls and model requests: the main agent's rules, under the child's id. */
	private createChildExtension(child: ChildGateContext): InlineExtension {
		const state = this.childState(child);
		const agent: GateAgent = {
			id: child.id,
			policy: () => this.childPolicy(state),
			tracker: state.tracker,
			session: () => state.session,
			waiting: (on, request) => child.waiting(on, request),
			signal: () => child.signal(),
		};
		return {
			name: "veyra-managed-subagent",
			hidden: true,
			factory: (fingers: ExtensionAPI) => {
				fingers.on("before_provider_headers", (event) => {
					this.addCorrelationHeaders(event.headers, state.tracer);
				});
				fingers.on("tool_call", async (event) => {
					try {
						return await this.gateToolCall(
							event.toolName,
							event.toolCallId,
							event.input as JsonRecord,
							event.parentToolCallId,
							agent,
						);
					} finally {
						this.releaseHeldStart(holdKey(child.id, event.toolCallId));
					}
				});
			},
		};
	}

	/** Watch a child's session: its records go to the host with its id, its spans to the telemetry relay. */
	private attachChild(child: ChildIdentity, session: AgentSession): () => void {
		const state = this.childState(child);
		state.session = session;
		const unsubscribe = session.subscribe((event) => this.onChildEvent(state, event));
		let unsubscribeTracer: (() => void) | undefined;
		if (this.tracer && this.configure) {
			const tracer = this.createRelayTracer(this.configure, child.id, () => session);
			state.tracer = tracer;
			unsubscribeTracer = session.subscribe((event) => this.traceEvent(tracer, event));
		}
		return () => {
			unsubscribe();
			unsubscribeTracer?.();
			for (const key of [...this.heldStarts.keys()]) {
				if (key.startsWith(`${child.id}\u0000`)) this.heldStarts.delete(key);
			}
			if (this.children.get(child.id) === state) this.children.delete(child.id);
		};
	}

	/**
	 * A child's records: its messages, tool calls, usage and file changes, with its `agent_id`. Its run's own
	 * lifecycle (agent_*, turn_*) is not forwarded: `subagent_*` is, and only the main agent ends a run.
	 */
	private onChildEvent(state: ChildState, event: AgentSessionEvent): void {
		const record = { ...(toJsonEvent(event) as JsonRecord), agent_id: state.id };
		switch (event.type) {
			case "tool_execution_start":
				this.heldStarts.set(holdKey(state.id, event.toolCallId), record);
				return;
			case "tool_execution_end": {
				this.releaseHeldStart(holdKey(state.id, event.toolCallId));
				this.emit(record);
				if (event.isError) {
					state.tracker.discard(event.toolCallId);
					return;
				}
				try {
					const change = state.tracker.after(event.toolCallId);
					if (change) {
						this.emit({ type: "file_changed", agent_id: state.id, ...change, tool_call_id: event.toolCallId });
					}
				} catch (error) {
					this.logger.warn("file change not computed", { agent_id: state.id, err: error });
				}
				return;
			}
			case "message_start":
			case "message_update":
			case "tool_execution_update":
				this.emit(record);
				return;
			case "message_end":
				this.emit(record);
				if (event.message.role === "assistant") this.recordUsage(event.message as AssistantMessage, state.id);
				return;
			default:
				return;
		}
	}

	/** The engine's lifecycle events as `subagent_started`, `subagent_updated` (on a status change) and `subagent_finished`. */
	private onSubagentEvent(event: SubagentEvent): void {
		const agent = event.agent;
		if (event.type === "subagent_started") {
			const status = agent.status === "queued" ? "queued" : "running";
			this.subagentStatus.set(agent.id, status);
			const worktree = this.worktreePath(agent.worktree);
			this.emit({
				type: "subagent_started",
				agent_id: agent.id,
				parent_agent_id: agent.parentId,
				label: agent.label,
				task: agent.task,
				...(agent.model ? { model: { provider: agent.model.provider, model_id: agent.model.id } } : {}),
				...(worktree ? { worktree } : {}),
				depends_on: [...new Set(agent.dependsOn)],
				status,
			});
			if (status !== agent.status) this.onSubagentEvent({ type: "subagent_updated", agent });
			return;
		}
		if (event.type === "subagent_updated") {
			if (this.subagentStatus.get(agent.id) === agent.status) return;
			this.subagentStatus.set(agent.id, agent.status);
			this.emit({ type: "subagent_updated", agent_id: agent.id, status: agent.status });
			return;
		}
		this.subagentStatus.delete(agent.id);
		const status = agent.status === "done" || agent.status === "failed" ? agent.status : "stopped";
		this.emit({
			type: "subagent_finished",
			agent_id: agent.id,
			status,
			usage: usageTotals(agent.usage),
			...(agent.summary ? { summary: agent.summary.slice(0, 4000) } : {}),
		});
		this.logger.info("sub-agent finished", {
			agent_id: agent.id,
			status,
			merged: agent.merged,
			cost_usd: agent.usage.cost.total,
		});
	}

	/** A worktree relative to the repository root, as the contract has it: relative to the workspace root. */
	private worktreePath(worktree: string | undefined): string | undefined {
		if (!worktree) return undefined;
		const root = this.repositoryRoot;
		const workspace = this.policy?.workspace.physical;
		if (!root || !workspace) return worktree;
		return relative(workspace, join(root, worktree)).split(sep).join("/");
	}

	/**
	 * The telemetry relay: every finished span (model calls, tool calls, compactions) becomes a `telemetry_span` record
	 * for the host, which sends it to Eyes as the run's Fingers feed or drops it. Spans continue the trace of the
	 * command that started the run, carry the run's ids and are masked: the host's secrets never appear in them, and
	 * prompts, answers and tool arguments only with `capture_content`.
	 */
	private createRelayTracer(
		configure: ManagedConfigure,
		agentId: string,
		session: () => AgentSession | undefined,
	): SessionTracer {
		const relay: SpanExporter = {
			content: configure.telemetry?.capture_content === true,
			export: (span) => this.emit({ type: "telemetry_span", span }),
		};
		const exporters = [relay];
		const runAttributes = {
			...(configure.run_id ? { "veyra.run_id": configure.run_id } : {}),
			"veyra.fingers.agent_id": agentId,
			...(configure.request_id && CORRELATION_ID.test(configure.request_id)
				? { "veyra.correlation_id": configure.request_id }
				: {}),
		};
		return new SessionTracer({
			exporters: () => exporters,
			parent: () => this.spanParent(),
			attributes: () => runAttributes,
			conversationId: () => session()?.sessionId,
			systemPrompt: () => session()?.systemPrompt,
			messages: () => session()?.messages ?? [],
			mask: { redactSecrets: (text) => this.secrets.redact(text) },
			onError: (error) => this.logger.warn("telemetry span not sent", { err: error }),
			now: () => this.now(),
		});
	}

	/**
	 * The parent of the run's spans and model requests: the host's span named by the `traceparent` of the command that
	 * started the run (Fingers' own command span is never exported), or that command span on a new trace.
	 */
	private spanParent(): TraceContext | undefined {
		const trace = this.workTrace ?? this.commandTrace;
		if (!trace) return undefined;
		return { traceId: trace.traceId, spanId: trace.parentSpanId ?? trace.spanId, flags: trace.flags };
	}

	/** Feed the relay tracer; it listens after the server, so a model call's span follows its `usage` record. */
	private traceEvent(tracer: SessionTracer | undefined, event: AgentSessionEvent): void {
		if (!tracer) return;
		switch (event.type) {
			case "agent_start":
				tracer.runStarted();
				return;
			case "message_start":
				if (event.message.role === "assistant") tracer.assistantStarted();
				return;
			case "message_end":
				if (event.message.role === "assistant") tracer.assistantEnded(event.message as AssistantMessage);
				return;
			case "tool_execution_start":
				tracer.toolStarted(event.toolCallId, event.toolName, event.args);
				return;
			case "tool_execution_end":
				tracer.toolEnded(event.toolCallId, event.toolName, event.result, event.isError);
				return;
			case "compaction_start":
				this.compactionStartedAt = this.now();
				return;
			case "compaction_end":
				if (event.result) {
					tracer.compacted(event.result.tokensBefore, event.result.estimatedTokensAfter, this.compactionStartedAt);
				}
				this.compactionStartedAt = undefined;
				return;
			case "agent_settled":
				tracer.runSettled(event.aborted);
				return;
		}
	}

	/** Memory is best effort: the run goes on without it, and the person watching hears it once per run. */
	private onMemoryUnavailable(error: MemoryUnavailableError): void {
		this.logger.warn("memory unavailable; continuing without it", { code: error.code, error: error.message });
		if (this.memoryNoticeSent) return;
		this.memoryNoticeSent = true;
		this.notice("warn", "memory_unavailable", "Brain memory is unavailable; the run continues without it.");
	}

	/**
	 * Every model request (turns, compaction, summaries) carries a new child span of the run's trace as
	 * `traceparent` and the run's `X-Request-Id` (contracts/v1/logging.md, Correlation headers).
	 */
	private addCorrelationHeaders(headers: ProviderHeaders, tracer: SessionTracer | undefined): void {
		const parent = this.spanParent();
		if (!parent) return;
		// With the telemetry relay, the request's span is the model call's `chat` span.
		const span = tracer?.modelRequest() ?? childSpan(parent);
		const requestId = this.configure?.request_id;
		for (const key of Object.keys(headers)) {
			if (!CORRELATION_HEADER.test(key)) continue;
			if (key.toLowerCase() === "x-request-id" && !requestId) continue;
			delete headers[key];
		}
		headers.traceparent = formatTraceparent(span);
		if (requestId) headers["x-request-id"] = requestId;
		this.logger.debug("model request", {
			trace_id: span.traceId,
			span_id: span.spanId,
			parent_span_id: span.parentSpanId,
		});
	}

	/** Path policy, then approval; null result lets the call run. */
	private async gateToolCall(
		toolName: string,
		toolCallId: string,
		input: JsonRecord,
		parentToolCallId: string | undefined,
		agent: GateAgent,
	): Promise<{ block: true; reason: string } | undefined> {
		const configure = this.configure!;
		const sub = agent.id === "main" ? undefined : agent.id;
		let policy: PathPolicy;
		try {
			policy = await agent.policy();
		} catch (error) {
			this.logger.warn("tool call blocked: no path policy for the sub-agent", {
				agent_id: sub,
				tool: toolName,
				tool_call_id: toolCallId,
				err: error,
			});
			return { block: true, reason: "Tool path is outside the workspace" };
		}
		const blocked = await checkManagedToolPaths(toolName, input, policy);
		if (blocked) {
			this.logger.warn("tool call blocked by the managed path policy", {
				agent_id: sub,
				tool: toolName,
				tool_call_id: toolCallId,
				reason: blocked,
			});
			return { block: true, reason: blocked };
		}
		const servers = (configure.mcp_servers ?? []).map((server) => server.name);
		const tool = describeManagedTool(toolName, servers, input);
		const serverMode = configure.mcp_servers?.find((server) => server.name === tool.server)?.approval;
		const mode: ApprovalMode =
			(tool.kind === "mcp_tool" ? serverMode : undefined) ?? configure.tools?.approval ?? "write_tools";
		const need = approvalNeed(tool, mode);
		if (need.required && !this.broker!.isAllowed(tool, input)) {
			agent.waiting?.(true, { command: approvalSummary(tool, input), reason: need.reason });
			let outcome: Awaited<ReturnType<ApprovalBroker["request"]>>;
			try {
				outcome = await this.broker!.request({
					toolCallId,
					tool,
					args: input,
					reason: need.reason,
					agentId: sub,
					signal: agent.signal?.(),
				});
			} finally {
				agent.waiting?.(false);
			}
			this.logger.info("approval resolved", {
				agent_id: sub,
				tool: toolName,
				tool_call_id: toolCallId,
				decision: outcome.decision,
				decided_by_type: outcome.decidedBy?.type,
				decided_by_id: outcome.decidedBy?.id,
			});
			try {
				agent.session()?.sessionManager.appendCustomEntry("veyra.approval", {
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
					agent_id: sub,
					tool: toolName,
					tool_call_id: toolCallId,
					reason: again,
				});
				return { block: true, reason: again };
			}
		}
		if (!parentToolCallId) agent.tracker.before(toolCallId, toolName, input);
		return undefined;
	}

	private releaseHeldStart(toolCallId: string): void {
		const held = this.heldStarts.get(toolCallId);
		if (!held) return;
		this.heldStarts.delete(toolCallId);
		this.emit(held);
	}

	/** Give a session's model runtime a provider's credential and base URL, and refresh the session's model. */
	private async applyCredentialsTo(session: AgentSession, message: CredentialsMessage): Promise<void> {
		await applyCredentials(session.modelRuntime, message, this.secrets);
		// The session holds the model object composed before the provider got its base URL: refresh it.
		const current = session.model;
		if (current?.provider === message.provider) {
			const refreshed = session.modelRuntime.getModel(current.provider, current.id);
			if (refreshed) session.agent.state.model = refreshed;
		}
	}

	private async bindSession(): Promise<void> {
		const runtime = this.runtime!;
		const session = runtime.session;
		this.session = session;
		// Secrets a provider echoes (an error body, a header) must not reach the session file either.
		session.sessionManager.setSerializedEntryFilter((line) => this.secrets.redactJsonLine(line));
		// A replaced session has a new model runtime: give it the credentials the host sent.
		for (const message of this.credentialMessages.values()) await this.applyCredentialsTo(session, message);
		this.unsubscribe?.();
		this.unsubscribe = session.subscribe((event) => this.onSessionEvent(event));
		this.unsubscribeTracer?.();
		const tracer = this.tracer;
		this.unsubscribeTracer = tracer ? session.subscribe((event) => this.traceEvent(tracer, event)) : undefined;
		// A limit reached during a turn ends the run after the turn's tool calls (the same stop as /budget).
		endRunAfterTurnWhen(session.agent, () => this.limitStop !== undefined);
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
			case "entry_appended":
				// The task's memory is Fingers' own state (like approval records): kept in the session, not announced.
				if (event.entry.type === "custom" && event.entry.customType === MEMORY_CONTEXT_ENTRY) return;
				this.emit(record);
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
		if (message.stopReason === "error") {
			const text = message.errorMessage ?? "unknown error";
			run.turnError = text;
			run.error = text;
		}
		this.recordUsage(message);
	}

	/**
	 * One model call of any agent: a `usage` record (with a sub-agent's `agent_id`), the process' cumulative totals and
	 * the limits, which count every agent. A sub-agent's failed call is its own failure, never the run's.
	 */
	private recordUsage(message: AssistantMessage, agentId?: string): void {
		this.totalTurns++;
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
		const priced = isListPriced(model);
		addTotals(this.cumulative, turn);
		this.emit({
			type: "usage",
			...(agentId ? { agent_id: agentId } : {}),
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
		if (
			priced &&
			limits.max_cost_usd !== undefined &&
			costCapReached(this.cumulative.cost_usd.total, limits.max_cost_usd)
		) {
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
				await this.applyCredentialsTo(session, message);
				this.credentialMessages.set(message.provider, message);
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
				if (this.limitStop && !session.isStreaming) {
					this.stopPromptAtLimit(id);
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
					this.steerSubagent(id, command);
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
					this.stopSubagent(id, command.agent_id);
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
				try {
					if (command.agent_id) await this.subagentCheckpoint(type, id, command);
					else if (type === "checkpoint_export") await this.exportCheckpoint(id, command);
					else await this.importCheckpoint(id, command);
				} catch (error) {
					if (!(error instanceof CheckpointError)) throw error;
					this.fail(id, type, error.code, error.message);
				}
				return;
			default:
				this.fail(id, type, "unknown_command", `Unknown command: ${type}`);
		}
	}

	/** `steer` with a sub-agent's `agent_id`: to that running sub-agent only (text; images reach the main agent only). */
	private steerSubagent(id: string | undefined, command: JsonRecord): void {
		const agentId = command.agent_id as string;
		if (command.images?.length) {
			this.fail(id, "steer", "unsupported", "A sub-agent takes text only; send images to the main agent");
			return;
		}
		if (!this.subagents?.engine()?.steer(agentId, command.message)) {
			this.fail(id, "steer", "not_found", `No running sub-agent ${agentId}`);
			return;
		}
		this.logger.info("message queued", { kind: "steer", agent_id: agentId, message_id: command.message_id });
		this.respond(id, "steer", { disposition: "queued" });
	}

	/** `abort` with a sub-agent's `agent_id`: stops that running or queued sub-agent and cancels its approvals. */
	private stopSubagent(id: string | undefined, agentId: string): void {
		const engine = this.subagents?.engine();
		const known = engine?.list().find((agent) => agent.id === agentId);
		if (!engine || !known || ["done", "failed", "stopped"].includes(known.status)) {
			this.fail(id, "abort", "not_found", `No running or queued sub-agent ${agentId}`);
			return;
		}
		this.broker?.cancelAgent(agentId);
		if (!engine.stop(agentId)) {
			this.fail(id, "abort", "not_found", `No running or queued sub-agent ${agentId}`);
			return;
		}
		this.logger.info("sub-agent stopped by the host", { agent_id: agentId });
		this.respond(id, "abort");
	}

	/**
	 * The budget is a hard stop for the whole process: once a limit was reached, a new prompt makes no model
	 * call. It still gets a run of its own (agent_start ... agent_settled, result) so the host closes its turn.
	 */
	private stopPromptAtLimit(id: string | undefined): void {
		const stop = this.limitStop!;
		this.logger.warn("prompt refused: a limit was reached", { command_id: id, stop_reason: stop.reason });
		this.respond(id, "prompt", { disposition: "started" });
		this.run = { startedAt: this.now(), turns: 0, limitNoticeSent: true };
		this.emit({ type: "agent_start" });
		this.notice("warn", "limit_reached", stop.notice);
		this.emit({ type: "agent_end", messages: [], willRetry: false });
		this.onAgentSettled({ type: "agent_settled", aborted: true });
	}

	// =====================================================================
	// Checkpoints
	// =====================================================================

	private async exportCheckpoint(id: string | undefined, command: JsonRecord): Promise<void> {
		const session = this.session!;
		const path = await resolveCheckpointPath(command.path, this.configure?.checkpoints?.dir);
		const sessionManager = session.sessionManager;
		const entryId = sessionManager.getLeafId();
		if (!entryId) throw new CheckpointError("not_found", "The session has no entries to checkpoint yet");
		const content = serializeCheckpoint(sessionManager, (line) => this.secrets.redactJsonLine(line));
		const { sha256, sizeBytes } = await writeCheckpointFile(path, content);
		const checkpoint = {
			id: checkpointId(path, sha256),
			format: CHECKPOINT_FORMAT,
			session_id: session.sessionId,
			entry_id: entryId,
			...(command.label !== undefined ? { label: command.label } : {}),
			path: command.path,
			sha256,
			size_bytes: sizeBytes,
			message_count: branchMessageCount(sessionManager),
			created_at: new Date(this.now()).toISOString(),
		};
		this.logger.info("checkpoint exported", {
			checkpoint_id: checkpoint.id,
			session_id: checkpoint.session_id,
			entry_id: entryId,
			sha256,
			size_bytes: sizeBytes,
		});
		this.respond(id, "checkpoint_export", { checkpoint });
		this.emit({
			type: "checkpoint_created",
			checkpoint_id: checkpoint.id,
			...(command.label !== undefined ? { label: command.label } : {}),
			sha256,
			size_bytes: sizeBytes,
			entry_id: entryId,
		});
	}

	/** One checkpoint export or import of `agentId` at a time. */
	private async withSubagentLock<T>(agentId: string, task: () => Promise<T>): Promise<T> {
		const previous = this.subagentLocks.get(agentId) ?? Promise.resolve();
		const next = previous.then(task, task);
		const settled = next.catch(() => undefined);
		this.subagentLocks.set(agentId, settled);
		try {
			return await next;
		} finally {
			if (this.subagentLocks.get(agentId) === settled) this.subagentLocks.delete(agentId);
		}
	}

	/**
	 * A sub-agent's checkpoint (`agent_id`): export holds it before its next model call, keeps the engine's checkpoint
	 * (its worktree as a commit, its transcript's point), writes its transcript and lets it go on; import rolls the
	 * running sub-agent back to a checkpoint this process took. The engine's checkpoints live in this process only.
	 */
	private async subagentCheckpoint(
		type: "checkpoint_export" | "checkpoint_import",
		id: string | undefined,
		command: JsonRecord,
	): Promise<void> {
		const agentId = command.agent_id as string;
		const path = await resolveCheckpointPath(command.path, this.configure?.checkpoints?.dir);
		const engine = this.subagents?.engine();
		const running = () => {
			const state = this.children.get(agentId);
			const status = engine?.list().find((agent) => agent.id === agentId)?.status;
			if (!engine || !state?.session || !status || ["queued", "done", "failed", "stopped"].includes(status)) {
				throw new CheckpointError("not_found", `No running sub-agent ${agentId}`);
			}
			return { engine, session: state.session };
		};
		if (type === "checkpoint_import") {
			const checkpoint = await readCheckpointFile(path, command.sha256);
			const known = this.subagentCheckpoints.get(String(command.sha256).toLowerCase());
			if (!known || known.agentId !== agentId || checkpoint.header.id !== running().session.sessionId) {
				throw new CheckpointError(
					"not_found",
					`This process kept no such checkpoint of ${agentId}: a sub-agent checkpoint is restored only in the process that took it, while the sub-agent runs`,
				);
			}
			await this.withSubagentLock(agentId, async () => {
				const { engine: live } = running();
				live.pause(agentId);
				try {
					await live.resume(agentId, known.checkpoint);
				} catch (error) {
					await live.resume(agentId).catch(() => undefined);
					throw new CheckpointError("not_found", errorMessage(error));
				}
			});
			const session = this.children.get(agentId)?.session;
			this.logger.info("sub-agent checkpoint imported", {
				agent_id: agentId,
				checkpoint: known.checkpoint,
				sha256: command.sha256,
			});
			this.respond(id, "checkpoint_import", {
				session_id: session?.sessionId ?? checkpoint.header.id,
				mode: "resume",
				entry_id: known.entryId,
			});
			return;
		}
		const taken = await this.withSubagentLock(agentId, async () => {
			const { engine: live, session } = running();
			const pausedHere = live.pause(agentId);
			try {
				const kept = await live.checkpoint(agentId).catch((error: unknown) => {
					throw new CheckpointError("not_found", errorMessage(error));
				});
				// Held before its next model call: the transcript is whole and does not move.
				const sessionManager = session.sessionManager;
				const entryId = sessionManager.getLeafId() ?? session.sessionId;
				const content = serializeCheckpoint(sessionManager, (line) => this.secrets.redactJsonLine(line));
				return {
					kept,
					entryId,
					content,
					messageCount: branchMessageCount(sessionManager),
					sessionId: session.sessionId,
				};
			} finally {
				if (pausedHere) await live.resume(agentId).catch(() => undefined);
			}
		});
		const { sha256, sizeBytes } = await writeCheckpointFile(path, taken.content);
		this.subagentCheckpoints.set(sha256, { agentId, checkpoint: taken.kept.id, entryId: taken.entryId });
		const checkpoint = {
			id: checkpointId(path, sha256),
			format: CHECKPOINT_FORMAT,
			session_id: taken.sessionId,
			entry_id: taken.entryId,
			...(command.label !== undefined ? { label: command.label } : {}),
			path: command.path,
			sha256,
			size_bytes: sizeBytes,
			message_count: taken.messageCount,
			created_at: new Date(this.now()).toISOString(),
			agent_id: agentId,
		};
		this.logger.info("sub-agent checkpoint exported", {
			agent_id: agentId,
			checkpoint_id: checkpoint.id,
			checkpoint: taken.kept.id,
			sha256,
			size_bytes: sizeBytes,
		});
		this.respond(id, "checkpoint_export", { checkpoint });
		this.emit({
			type: "checkpoint_created",
			agent_id: agentId,
			checkpoint_id: checkpoint.id,
			...(command.label !== undefined ? { label: command.label } : {}),
			sha256,
			size_bytes: sizeBytes,
			entry_id: taken.entryId,
		});
	}

	private async importCheckpoint(id: string | undefined, command: JsonRecord): Promise<void> {
		const session = this.session!;
		const runtime = this.runtime!;
		const mode = command.mode as "resume" | "fork";
		if (mode === "resume" && command.entry_id !== undefined) {
			throw new CheckpointError("invalid_command", "entry_id applies to mode fork only");
		}
		if (session.isStreaming || this.run) {
			this.fail(id, "checkpoint_import", "busy", "A run is active: import a checkpoint between runs");
			return;
		}
		const path = await resolveCheckpointPath(command.path, this.configure?.checkpoints?.dir);
		const checkpoint = await readCheckpointFile(path, command.sha256);
		const ids = new Set(checkpoint.entries.slice(1).map((entry) => (entry as { id: string }).id));
		const forkAt = mode === "fork" ? (command.entry_id as string | undefined) : undefined;
		if (forkAt !== undefined && !ids.has(forkAt)) {
			throw new CheckpointError("not_found", `No entry ${forkAt} in the checkpoint`);
		}
		const workspaceRoot = this.policy!.workspace.logical;
		const sessionDir = session.sessionManager.getSessionDir();
		const stored = await storeImportedSession(checkpoint, sessionDir, workspaceRoot);
		let target = stored;
		let entryId: string | undefined;
		if (mode === "fork") {
			// A new session holding the path from the root to the fork entry; its parent is the stored checkpoint.
			const source = SessionManager.open(stored, sessionDir);
			entryId = forkAt ?? source.getLeafId() ?? undefined;
			if (!entryId) throw new CheckpointError("not_found", "The checkpoint has no entries to fork from");
			const branched = source.createBranchedSession(entryId);
			if (!branched) throw new Error("The forked session could not be created");
			target = branched;
		}
		const result = await runtime.switchSession(target, { cwdOverride: workspaceRoot });
		if (result.cancelled) throw new Error("The session switch was cancelled");
		const current = this.session!;
		const data = {
			session_id: current.sessionId,
			mode,
			entry_id: entryId ?? current.sessionManager.getLeafId() ?? checkpoint.header.id,
			...(mode === "fork" ? { forked_from: checkpoint.header.id } : {}),
		};
		this.logger.info("checkpoint imported", {
			mode,
			session_id: data.session_id,
			entry_id: data.entry_id,
			forked_from: mode === "fork" ? checkpoint.header.id : undefined,
			sha256: command.sha256,
		});
		this.respond(id, "checkpoint_import", data);
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
		this.memory?.close();
		try {
			if (this.session && !this.session.isIdle) await this.session.abort();
		} catch (error) {
			this.logger.warn("abort during shutdown failed", { err: error });
		}
		this.unsubscribe?.();
		this.unsubscribeTracer?.();
		this.unsubscribeSubagents?.();
		await this.runtime?.dispose().catch((error) => this.logger.warn("dispose failed", { err: error }));
	}
}
