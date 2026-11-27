/**
 * A Fingers session that runs in a Hands Sandbox (`fingers --hands`): the runner and Fingers start inside a
 * fresh sandbox, the model calls go through Hands' model proxy with the organization's model connection, Brain gives
 * the run the repository's memory and Eyes gets its telemetry; the person's files go up and the changes come back.
 *
 * The session is a line-mode client of Hands' runs API (hands.yaml):
 * 1. checks the sign-in, that Hands is on in the organization and which model connection to use (the organization's model connections);
 * 2. syncs the workspace up (hands-workspace.ts) and creates the run (`observability.send_to_eyes`, and
 *    `memory.brain_space_id` when Brain has the repository's space);
 * 3. follows the run's events (SSE, replayed from the last `seq` after a drop) and prints them; in a terminal, a line
 *    typed while the run works steers it (`POST /runs/{id}/messages`) and answers a pending approval;
 * 4. Ctrl-C cancels the run (Hands destroys the sandbox); at every run end the changed files come back;
 * 5. in a terminal, a next message continues the conversation: a fork of the run's latest checkpoint when the files are
 *    still what came back, otherwise a fresh run with a fresh sync.
 *
 * Nothing here holds a provider key: Hands leases the connection's credential and keeps it server-side.
 */
import { randomUUID } from "node:crypto";
import { VERSION } from "../../config.ts";
import { projectRepository, repositoryShortName } from "../../core/memory/project.ts";
import { continueTrace, type TraceContext } from "../../core/trace-context.ts";
import {
	HandsApiError,
	HandsClient,
	type HandsRun,
	type HandsRunCreate,
	type HandsRunEvent,
	TERMINAL_RUN_STATUSES,
} from "../../core/veyra/hands-client.ts";
import {
	type Git,
	HandsWorkspaceError,
	type PullBackResult,
	planWorkspace,
	pullBack,
	runGit,
	unchangedSincePull,
	uploadWorkspace,
	type WorkspacePlan,
} from "../../core/veyra/hands-workspace.ts";
import { connectText } from "../../core/veyra/login-text.ts";
import {
	fetchModelConnections,
	isConnectionProviderId,
	ModelConnectionsError,
	type ModelConnectionsSource,
	modelConnectionsSummary,
	type OfferedConnection,
} from "../../core/veyra/model-connections.ts";
import type { VeyraAccount } from "../../core/veyra/session-vault.ts";
import { type VeyraOrganization, VeyraSignedOutError } from "../../core/veyra/veyra-auth.ts";

/** The part of VeyraAuth the session needs (tests pass a stub). */
export interface HandsSessionAuth extends ModelConnectionsSource {
	account(): VeyraAccount | undefined;
	apiBaseUrl(app: "hands" | "brain"): string;
	getAccessToken(app: "hands" | "brain", options?: { signal?: AbortSignal }): Promise<string>;
	organization(options?: { signal?: AbortSignal }): Promise<VeyraOrganization>;
}

/** Lines the person types (readline in the terminal). `next` gives the next one, or undefined once input ends. */
interface LineSource {
	next(signal?: AbortSignal): Promise<string | undefined>;
}

/** A queue of typed lines: the terminal pushes them, the session takes them; a cancelled wait loses no line. */
export class LineQueue implements LineSource {
	private readonly lines: string[] = [];
	private readonly waiters: Array<(line: string | undefined) => void> = [];
	private closed = false;

	push(line: string): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter(line);
		else this.lines.push(line);
	}

	close(): void {
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter(undefined);
	}

	next(signal?: AbortSignal): Promise<string | undefined> {
		const line = this.lines.shift();
		if (line !== undefined) return Promise.resolve(line);
		if (this.closed || signal?.aborted) return Promise.resolve(undefined);
		return new Promise((resolve) => {
			const waiter = (value: string | undefined) => {
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			};
			const onAbort = () => {
				const index = this.waiters.indexOf(waiter);
				if (index >= 0) this.waiters.splice(index, 1);
				resolve(undefined);
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.waiters.push(waiter);
		});
	}
}

interface HandsSessionOptions {
	auth: HandsSessionAuth;
	cwd: string;
	prompt: string;
	/** `text` prints lines for people, `json` one RunEvent per line. */
	output: "text" | "json";
	write: (text: string) => void;
	/** A terminal session: steering, approvals and follow-ups read `input`. */
	interactive: boolean;
	input?: LineSource;
	/** `--provider` / `--model` (`veyra-<connection>/<model>` or a model id). */
	provider?: string;
	model?: string;
	/** The settings' default provider and model. */
	defaultProvider?: string;
	defaultModel?: string;
	/** `--hands-size` or the `hands.size` setting. */
	size?: string;
	/** Registers the stop handler (Ctrl-C, SIGTERM, SIGHUP); returns the unregister function. */
	onInterrupt?: (handler: () => void) => () => void;
	fetch?: typeof fetch;
	git?: Git;
	/** How long a stop waits for Hands to end the run (default 30 s). */
	stopWaitMs?: number;
	/** Waits between stream reconnects (tests pass 0). */
	retryDelayMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

/** The end of a session: the exit code and the last run. */
interface HandsSessionResult {
	exitCode: number;
	run?: HandsRun;
}

class SessionStopped extends Error {}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function safe(value: unknown, max = 4_000): string {
	return typeof value === "string" ? connectText(value.slice(0, max)) : "";
}

/** `veyra-mc_1/claude-sonnet-4-5` -> provider + model; a plain model id has no provider. */
function splitModel(value: string | undefined): { provider?: string; model?: string } {
	if (!value) return {};
	const slash = value.indexOf("/");
	if (slash > 0 && isConnectionProviderId(value.slice(0, slash))) {
		return { provider: value.slice(0, slash), model: value.slice(slash + 1) || undefined };
	}
	return { model: value };
}

function connectionLabel(entry: OfferedConnection): string {
	return `${entry.providerId} (${safe(entry.connection.name) || entry.route.label})`;
}

/**
 * The model connection and model a Hands run uses: `--model veyra-<conn>/<model>`, `--provider veyra-<conn>`, the
 * default provider when it is a Veyra connection, or the first offered connection with its first tested model.
 */
export function chooseModel(
	offered: readonly OfferedConnection[],
	wanted: { provider?: string; model?: string; defaultProvider?: string; defaultModel?: string },
): { connection: OfferedConnection; model: string } {
	const fromModel = splitModel(wanted.model);
	const provider = wanted.provider ?? fromModel.provider;
	const list = offered.map(connectionLabel).join(", ");
	const pick = (connection: OfferedConnection, model: string | undefined) => {
		const id = model ?? connection.connection.models[0];
		if (!id) {
			throw new HandsSessionError(
				`Name the model for ${connectionLabel(connection)}: --model ${connection.providerId}/<model id>.`,
			);
		}
		return { connection, model: id };
	};
	if (provider) {
		if (!isConnectionProviderId(provider)) {
			throw new HandsSessionError(
				`Hands runs use your organization's model connections, and ${safe(provider)} is not one. Pick one of: ${list || "none offered"}.`,
			);
		}
		const connection = offered.find((entry) => entry.providerId === provider);
		if (!connection) {
			throw new HandsSessionError(
				`${safe(provider)} is not one of the model connections Connect opens to you. Pick one of: ${list || "none offered"}.`,
			);
		}
		const model =
			fromModel.model ?? (provider === wanted.defaultProvider ? wanted.defaultModel : undefined) ?? undefined;
		return pick(connection, model);
	}
	if (wanted.defaultProvider && isConnectionProviderId(wanted.defaultProvider)) {
		const connection = offered.find((entry) => entry.providerId === wanted.defaultProvider);
		if (connection) return pick(connection, fromModel.model ?? wanted.defaultModel);
	}
	const first =
		(fromModel.model ? offered.find((entry) => entry.connection.models.includes(fromModel.model!)) : undefined) ??
		offered[0];
	if (!first) throw new HandsSessionError("No model connection from Connect is open to Fingers and Hands.");
	return pick(first, fromModel.model);
}

/** A reason the session can't start, for the person. */
export class HandsSessionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HandsSessionError";
	}
}

/** The Brain space of the repository, when Brain has one the person may read; otherwise why memory is off. */
async function brainSpace(
	options: HandsSessionOptions,
	org: VeyraOrganization,
	root: string,
): Promise<{ id: string; label: string } | { off: string }> {
	if (!org.appsEnabled.includes("brain")) return { off: "Brain is off in the organization" };
	const repository = await projectRepository(root);
	if (!repository) return { off: "this directory has no git remote to name its memory" };
	const fetchImpl = options.fetch ?? fetch;
	try {
		const token = await options.auth.getAccessToken("brain");
		const base = options.auth.apiBaseUrl("brain").replace(/\/+$/, "");
		const response = await fetchImpl(`${base}/spaces/${encodeURIComponent(`subject:project:${repository}`)}`, {
			headers: { authorization: `Bearer ${token}`, accept: "application/json", "x-request-id": randomUUID() },
		});
		if (response.status === 404) return { off: `Brain has no memory of ${repositoryShortName(repository)} yet` };
		if (!response.ok) return { off: `Brain answered ${response.status}` };
		const body = (await response.json()) as { id?: unknown };
		if (typeof body.id !== "string" || body.id.length === 0 || body.id.length > 100) {
			return { off: "Brain's answer names no space" };
		}
		return { id: body.id, label: repositoryShortName(repository) };
	} catch (error) {
		return { off: `Brain could not be asked (${safe(error instanceof Error ? error.message : String(error), 200)})` };
	}
}

function money(run: HandsRun): string | undefined {
	const cost = run.usage?.model_cost;
	if (typeof cost?.amount_minor !== "number") return undefined;
	const amount = (cost.amount_minor / 100).toFixed(2);
	return cost.currency === "USD" || !cost.currency ? `$${amount}` : `${amount} ${safe(cost.currency, 8)}`;
}

function tokens(value: number | undefined): string {
	if (typeof value !== "number") return "0";
	return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function duration(seconds: number | undefined): string | undefined {
	if (typeof seconds !== "number") return undefined;
	const total = Math.round(seconds);
	return total >= 60 ? `${Math.floor(total / 60)}m ${total % 60}s` : `${total}s`;
}

function argumentsSummary(value: unknown): string {
	if (typeof value !== "object" || value === null) return "";
	const parts: string[] = [];
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		const text = typeof item === "string" ? item : JSON.stringify(item);
		parts.push(`${safe(key, 40)}=${safe(text ?? "", 120)}`);
		if (parts.join(" ").length > 160) break;
	}
	const joined = parts.join(" ");
	return joined.length > 160 ? `${joined.slice(0, 159)}…` : joined;
}

/** Runs a Hands-backed session to its end. Never throws for what the person can fix: it prints and returns 1. */
export async function runHandsSession(options: HandsSessionOptions): Promise<HandsSessionResult> {
	const text = options.output === "text";
	const say = (line: string) => {
		if (text) options.write(`${line}\n`);
	};
	const fail = (message: string): HandsSessionResult => {
		if (text) options.write(`${message}\n`);
		else options.write(`${JSON.stringify({ type: "fingers.hands.error", message })}\n`);
		return { exitCode: 1 };
	};

	const account = options.auth.account();
	if (!account) return fail(new VeyraSignedOutError("not_signed_in").message);

	let org: VeyraOrganization;
	let offered: OfferedConnection[];
	try {
		org = await options.auth.organization();
		if (!org.appsEnabled.includes("hands")) {
			return fail(
				`Hands is off in ${safe(org.name) || "your organization"}. An admin turns it on in Connect, or run locally without --hands.`,
			);
		}
		const list = await fetchModelConnections(options.auth);
		offered = list.offered;
		if (offered.length === 0) return fail(modelConnectionsSummary(list).text);
	} catch (error) {
		if (error instanceof VeyraSignedOutError || error instanceof ModelConnectionsError) return fail(error.message);
		return fail(`Veyra could not be asked: ${safe(error instanceof Error ? error.message : String(error), 300)}`);
	}

	let choice: { connection: OfferedConnection; model: string };
	try {
		choice = chooseModel(offered, options);
	} catch (error) {
		return fail((error as Error).message);
	}

	const git = options.git ?? runGit;
	let plan: WorkspacePlan;
	try {
		plan = await planWorkspace(options.cwd, git);
	} catch (error) {
		if (error instanceof HandsWorkspaceError) return fail(error.message);
		throw error;
	}

	const trace: TraceContext = continueTrace(undefined).context;
	const client = new HandsClient({
		auth: options.auth,
		trace,
		userAgent: `fingers/${VERSION} (${process.platform})`,
		fetch: options.fetch,
	});
	const space = await brainSpace(options, org, plan.root);
	const session = new RunFollower(options, client, text);

	say(
		`Hands · ${safe(org.name)} · ${safe(choice.connection.connection.name) || choice.connection.route.label} · ${safe(choice.model, 200)}`,
	);
	say(`workspace: ${safe(plan.summary, 300)}`);

	let memory: HandsRunCreate["memory"] = "id" in space ? { brain_space_id: space.id, learn: true } : undefined;
	let memoryLine = "id" in space ? `memory: Brain ${safe(space.label, 100)}` : `memory: off (${space.off})`;

	const unregister = options.onInterrupt?.(() => session.interrupt());
	try {
		const create = async (prompt: string): Promise<HandsRun> => {
			if (plan.upload.length > 0) say(`Uploading ${plan.upload.length} file${plan.upload.length === 1 ? "" : "s"}…`);
			const workspace = await uploadWorkspace(client, plan, { signal: session.signal });
			const body = (withMemory: boolean): HandsRunCreate => ({
				task: { title: prompt.split("\n")[0]!.slice(0, 200), prompt },
				model: { connection_id: choice.connection.connection.id, model: choice.model },
				harness: { name: "fingers" },
				workspace,
				target: { type: "sandbox", ...(options.size ? { size: options.size } : {}) },
				observability: { send_to_eyes: true },
				...(withMemory && memory ? { memory } : {}),
				metadata: { client: "fingers-cli", fingers_version: VERSION },
			});
			try {
				return session.started(await client.createRun(body(true), randomUUID(), session.signal));
			} catch (error) {
				// Hands refuses the memory until it gives runs Brain memory (hands H25), or the group lacks Brain's
				// permissions: the run goes ahead without memory, and the header says why.
				if (memory && error instanceof HandsApiError && memoryRefusal(error)) {
					memoryLine = `memory: off (Hands: ${memoryRefusal(error)})`;
					memory = undefined;
					return session.started(await client.createRun(body(false), randomUUID(), session.signal));
				}
				throw error;
			}
		};

		let run = await create(options.prompt);
		say(memoryLine);
		say("telemetry: Eyes, when the organization's Hands feed is on");
		say(
			`Run ${safe(run.id, 100)} ${safe(run.status, 40)}${options.interactive ? " · type to steer, Ctrl-C stops" : ""}`,
		);
		let exitCode = 0;
		while (true) {
			const finished = await session.follow(run);
			run = finished.run;
			let pulled: PullBackResult | undefined;
			if (!session.hardStopped) {
				try {
					pulled = await pullBack(client, run.id, plan, session.signal);
				} catch (error) {
					if (session.hardStopped) throw new SessionStopped();
					say(
						`! The run's changes could not be fetched (${safe(error instanceof Error ? error.message : String(error), 300)}); they stay with run ${safe(run.id, 100)} in Hands.`,
					);
				}
			}
			session.summary(run, pulled);
			exitCode = session.stopped ? 130 : run.status === "succeeded" ? 0 : 1;
			if (!options.interactive || !options.input || session.stopped) break;
			say("Next message for this session (empty line ends it):");
			const next = (await options.input.next(session.signal))?.trim();
			if (!next || next === "/exit") break;
			const checkpoints = await client.listCheckpoints(run.id).catch(() => []);
			const latest = checkpoints[checkpoints.length - 1];
			if (latest && (await unchangedSincePull(plan, git))) {
				run = session.started(await client.forkCheckpoint(run.id, latest.id, next, session.signal));
				say(`Run ${safe(run.id, 100)} continues from ${safe(latest.id, 100)}`);
			} else {
				say(
					latest
						? "Your files changed since the last run, so this starts a fresh run with them."
						: "The last run kept no checkpoint, so this starts a fresh run.",
				);
				plan = await planWorkspace(options.cwd, git);
				run = await create(next);
				say(`Run ${safe(run.id, 100)} ${safe(run.status, 40)}`);
			}
		}
		return { exitCode: session.hardStopped ? 130 : exitCode, run };
	} catch (error) {
		if (error instanceof SessionStopped || session.hardStopped) {
			await session.settle();
			return { exitCode: 130, run: session.lastRun };
		}
		if (error instanceof HandsWorkspaceError) return fail(error.message);
		if (error instanceof HandsApiError) return fail(handsErrorText(error));
		if (error instanceof VeyraSignedOutError) return fail(error.message);
		throw error;
	} finally {
		unregister?.();
		session.close();
	}
}

/** Why Hands refused the run's memory, when that is what it refused. */
function memoryRefusal(error: HandsApiError): string | undefined {
	if (error.status === 400) return error.fieldError("memory.brain_space_id");
	if (error.status === 403 && error.permission?.startsWith("brain:")) {
		return `your group lacks Brain ${error.permission.slice("brain:".length)}`;
	}
	return undefined;
}

/** Hands' refusal for the person, with what to do. */
function handsErrorText(error: HandsApiError): string {
	if (error.status === 401) return "Hands did not take the sign-in. Run fingers login again.";
	if (error.status === 403 && error.permission) {
		return `Your group may not do this in Hands (${error.permission}). Ask an admin of the organization.`;
	}
	if (error.status === 402) return `Hands: ${error.detail ?? "your organization's plan does not allow this run"}.`;
	const fields = error.fieldErrors.map((entry) => `${entry.field ? `${entry.field}: ` : ""}${entry.message}`);
	return `Hands refused the run${error.detail ? `: ${error.detail}` : ""}${fields.length > 0 ? ` (${fields.join("; ")})` : ""}.`;
}

/** Follows one run at a time: prints its events, handles steering, approvals and the stop. */
class RunFollower {
	private readonly options: HandsSessionOptions;
	private readonly client: HandsClient;
	private readonly text: boolean;
	private readonly controller = new AbortController();
	private pendingApproval: string | undefined;
	private current: HandsRun | undefined;
	stopped = false;
	hardStopped = false;
	private stopTimer: ReturnType<typeof setTimeout> | undefined;
	/** The cancel request of a stop, so that leaving at once still lets it reach Hands. */
	private cancelling: Promise<void> | undefined;
	private followAbort: AbortController | undefined;

	constructor(options: HandsSessionOptions, client: HandsClient, text: boolean) {
		this.options = options;
		this.client = client;
		this.text = text;
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get lastRun(): HandsRun | undefined {
		return this.current;
	}

	/** A run Hands just created: from now on a stop cancels it. */
	started(run: HandsRun): HandsRun {
		this.current = run;
		return run;
	}

	private say(line: string): void {
		if (this.text) this.options.write(`${line}\n`);
	}

	/** Ctrl-C: the first cancels the run (its changes still come back), the second ends the session at once. */
	interrupt(): void {
		// Before a run exists (files still going up), or between runs, there is nothing to cancel: stop at once.
		if (this.stopped || !this.current || TERMINAL_RUN_STATUSES.has(this.current.status)) {
			this.stopped = true;
			this.hardStopped = true;
			this.controller.abort();
			this.followAbort?.abort();
			return;
		}
		this.stopped = true;
		const run = this.current;
		this.say("Stopping the run… (Ctrl-C again to leave at once)");
		this.cancelling = this.client
			.cancelRun(run.id, "Stopped in Fingers")
			.then(() => undefined)
			.catch((error: unknown) => {
				this.say(
					`! Hands did not take the stop: ${safe(error instanceof Error ? error.message : String(error), 300)}`,
				);
			});
		this.stopTimer = setTimeout(() => this.followAbort?.abort(), this.options.stopWaitMs ?? 30_000);
	}

	/** Waits (at most `ms`) for a stop's cancel request to reach Hands. */
	async settle(ms = 5_000): Promise<void> {
		if (!this.cancelling) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, ms);
		});
		await Promise.race([this.cancelling, timeout]);
		if (timer) clearTimeout(timer);
	}

	close(): void {
		if (this.stopTimer) clearTimeout(this.stopTimer);
		this.followAbort?.abort();
	}

	/** Follows `run` until Hands says it finished; returns the run as Hands has it then. */
	async follow(run: HandsRun): Promise<{ run: HandsRun }> {
		this.current = run;
		const follow = new AbortController();
		this.followAbort = follow;
		const signal = AbortSignal.any([follow.signal, this.controller.signal]);
		const input = this.options.interactive && this.options.input ? this.readInput(run.id, signal) : undefined;
		let after = 0;
		let failures = 0;
		const sleep = this.options.sleep ?? defaultSleep;
		try {
			while (!signal.aborted) {
				let finished = false;
				try {
					for await (const event of this.client.streamEvents(run.id, after, signal)) {
						failures = 0;
						if (event.seq <= after) continue;
						after = event.seq;
						await this.handle(event, signal);
						if (event.type === "run.finished") {
							finished = true;
							break;
						}
					}
				} catch (error) {
					if (signal.aborted) break;
					if (
						error instanceof HandsApiError &&
						error.status >= 400 &&
						error.status < 500 &&
						error.status !== 429
					) {
						throw error;
					}
					failures += 1;
				}
				if (finished) break;
				// The stream ended early: catch up from the replay, and stop once Hands says the run is over.
				const page = await this.client.listEvents(run.id, after, signal).catch(() => undefined);
				for (const event of page?.data ?? []) {
					if (event.seq <= after) continue;
					after = event.seq;
					await this.handle(event, signal);
					if (event.type === "run.finished") finished = true;
				}
				if (finished) break;
				const now = await this.client.getRun(run.id, signal).catch(() => undefined);
				if (now && TERMINAL_RUN_STATUSES.has(now.status)) break;
				if (failures > 10) {
					throw new HandsApiError(503, { detail: "the run's events could not be followed; it goes on in Hands" });
				}
				await sleep(Math.min(5_000, (this.options.retryDelayMs ?? 1_000) * Math.max(1, failures)));
			}
		} finally {
			follow.abort();
			await input;
		}
		if (this.hardStopped) throw new SessionStopped();
		const final = await this.client.getRun(run.id).catch(() => run);
		this.current = final;
		return { run: final };
	}

	private async readInput(runId: string, signal: AbortSignal): Promise<void> {
		const input = this.options.input!;
		while (!signal.aborted) {
			const raw = await input.next(signal);
			if (raw === undefined) return;
			const line = raw.trim();
			if (!line) continue;
			try {
				if (line === "/stop") {
					this.interrupt();
				} else if (this.pendingApproval) {
					const id = this.pendingApproval;
					this.pendingApproval = undefined;
					const approve = /^(y|yes)$/i.test(line);
					const reason = approve || /^(n|no)$/i.test(line) ? undefined : line.slice(0, 2000);
					await this.client.decideApproval(id, approve ? "approve" : "deny", reason, signal);
				} else {
					await this.client.sendMessage(runId, line.slice(0, 20_000), signal);
					this.say("  → sent to the agent");
				}
			} catch (error) {
				if (signal.aborted) return;
				if (error instanceof HandsApiError && error.status === 409) {
					this.say("  Hands: that is already decided, or the run is no longer running.");
				} else {
					this.say(`  ! ${safe(error instanceof Error ? error.message : String(error), 300)}`);
				}
			}
		}
	}

	private async handle(event: HandsRunEvent, signal: AbortSignal): Promise<void> {
		if (!this.text) {
			this.options.write(`${JSON.stringify(event)}\n`);
			return;
		}
		const data = event.data;
		switch (event.type) {
			case "sandbox.ready":
				this.say("Sandbox ready");
				break;
			case "workspace.ready":
				this.say("Workspace ready");
				break;
			case "agent.message":
				if (safe(data.text, 100_000)) this.say(safe(data.text, 100_000));
				break;
			case "tool_call.started":
				this.say(`› ${safe(data.tool, 100)} ${argumentsSummary(data.arguments)}`.trimEnd());
				break;
			case "tool_call.finished":
				if (data.ok === false) {
					this.say(`  ✗ failed${typeof data.exit_code === "number" ? ` (exit ${data.exit_code})` : ""}`);
				}
				break;
			case "file.changed":
				this.say(
					`  ~ ${safe(data.path, 300)}${typeof data.additions === "number" ? ` +${data.additions}` : ""}${typeof data.deletions === "number" ? ` −${data.deletions}` : ""}`,
				);
				break;
			case "steering.received":
				this.say(`  steering: ${safe(data.text, 300)}`);
				break;
			case "approval.requested":
				await this.askApproval(String(data.approval_id ?? ""), signal);
				break;
			case "approval.resolved":
				this.pendingApproval = undefined;
				this.say(`  approval ${safe(data.decision, 20) || "resolved"}`);
				break;
			case "checkpoint.created":
				this.say(`  checkpoint ${safe(data.label, 200) || safe(data.checkpoint_id, 100)}`);
				break;
			case "log":
				if (data.level === "warn" || data.level === "error") this.say(`! ${safe(data.message, 1_000)}`);
				break;
			case "run.finished":
				break;
			default:
				break;
		}
	}

	private async askApproval(id: string, signal: AbortSignal): Promise<void> {
		if (!id) return;
		const approval = await this.client.getApproval(id, signal).catch(() => undefined);
		const what = approval
			? `${safe(approval.tool.server, 100)}.${safe(approval.tool.name, 100)} ${argumentsSummary(approval.tool.arguments)}`.trimEnd()
			: "a tool call";
		if (this.options.interactive && this.options.input) {
			this.pendingApproval = id;
			this.say(`? ${what} waits for your approval: y approves, anything else denies (the text is the reason)`);
		} else {
			this.say(`? ${what} waits for approval ${safe(id, 100)}: decide it in the Hands console`);
		}
	}

	summary(run: HandsRun, pulled: PullBackResult | undefined): void {
		if (!this.text) {
			this.options.write(
				`${JSON.stringify({
					type: "fingers.hands.summary",
					run_id: run.id,
					status: run.status,
					failure: run.failure ?? null,
					usage: run.usage ?? null,
					eyes_url: run.eyes_url ?? null,
					files: pulled ?? null,
				})}\n`,
			);
			return;
		}
		const parts = [`Run ${safe(run.status, 40)}`];
		const time = duration(run.usage?.duration_seconds);
		if (time) parts.push(time);
		if (run.usage) parts.push(`${tokens(run.usage.input_tokens)} in / ${tokens(run.usage.output_tokens)} out`);
		const cost = money(run);
		if (cost) parts.push(cost);
		this.say(`${parts.join(" · ")}${run.failure?.message ? `: ${safe(run.failure.message, 500)}` : ""}`);
		if (pulled) {
			const changed = [...pulled.written, ...pulled.removed];
			if (changed.length > 0) {
				this.say(
					`✓ ${changed.length} file${changed.length === 1 ? "" : "s"} from Hands: ${changed
						.slice(0, 8)
						.map((path) => safe(path, 200))
						.join(", ")}${changed.length > 8 ? ", …" : ""}`,
				);
			}
			for (const conflict of pulled.conflicts) {
				this.say(
					`! kept your change to ${safe(conflict.path, 300)}${conflict.savedAs ? `; the run's version is in ${safe(conflict.savedAs, 400)}` : " (the run deleted it)"}`,
				);
			}
			for (const path of pulled.refused) this.say(`! not written (outside the workspace): ${safe(path, 300)}`);
		}
		if (run.eyes_url) this.say(`Eyes: ${safe(run.eyes_url, 500)}`);
	}
}
