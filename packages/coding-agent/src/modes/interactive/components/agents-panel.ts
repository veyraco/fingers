/**
 * The sub-agents panel (canvas FingersTuiAgents): `/agents` in the terminal app, in place of the editor while
 * sub-agents are on (an ee feature; the engine comes from core/subagents/registry.ts, so the panel itself is open
 * core and holds no engine).
 *
 * It lists this process' sub-agents with their task, status, tokens and cost, the models they run on, and for the
 * selected one its last steps, the approval it waits for and its checkpoints. Keys as on the artboard:
 * enter open (its transcript), a approve (opens the approval box of the question it waits on), s steer, p pause,
 * k stop, c checkpoint, r resume (from where it paused, or from a checkpoint), esc back; x removes the worktree an
 * ended sub-agent kept.
 *
 * While the panel is open, children's approval questions wait on the registry's approval desk (the row shows
 * "waiting for approval"); closing the panel lets them through to the approval box as before.
 *
 * The artboard says "checkpoints saved to Hands": in the terminal app a checkpoint is a git commit of the child's
 * worktree plus a point of its transcript, kept in this process. Hands checkpoints of sub-agents belong to managed
 * RPC (F18b).
 */
import {
	type Component,
	type Focusable,
	getKeybindings,
	Input,
	truncateToWidth,
	visibleWidth,
} from "@veyraco/fingers-tui";
import type { SubagentEngines } from "../../../core/subagents/registry.ts";
import type { SubagentInfo, SubagentTranscriptLine } from "../../../core/subagents/types.ts";
import { theme } from "../theme/theme.ts";
import { formatCost, formatTokenCount } from "./footer.ts";
import { renderShellBox } from "./shell-box.ts";

export const AGENTS_PANEL_KEYS =
	"enter open · a approve · s steer · p pause · k stop · c checkpoint · r resume · esc back";
const OPEN_KEYS = "↑↓ scroll · esc back";
const PICK_KEYS = "↑↓ choose · enter resume · esc back";
const TABLE_WIDTH = 100;
const BOX_WIDTH = 104;
/** Transcript rows the open view shows at once. */
const TRANSCRIPT_ROWS = 22;

export interface AgentsPanelOptions {
	engines: SubagentEngines;
	/** The parent's model id, for "parent: …". */
	parentModel?: string;
	/** The parent's task (its last prompt), for "task: …". */
	task?: string;
	/** Closes the panel. */
	onClose: () => void;
	/** Asks the terminal to draw again (events, the clock). */
	requestRender: () => void;
	/** For tests. */
	now?: () => number;
	/** Redraw interval while a sub-agent runs (ms); 0 turns the clock off. Default 1000. */
	tickMs?: number;
}

type Mode = "list" | "open" | "steer" | "pick";

/** One line without terminal escapes or line breaks. */
function clean(text: string): string {
	return text
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function pad(text: string, width: number): string {
	const cut = truncateToWidth(text, width, "…");
	return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

function padStart(text: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

/** "2:10" for 130 s. */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	if (minutes >= 60)
		return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
	return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** "12:04", the local time of a checkpoint. */
function clock(at: number): string {
	const date = new Date(at);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** "3" for "sub_3": the row number the artboard shows. */
export function agentNumber(id: string): string {
	return id.startsWith("sub_") ? id.slice(4) : id;
}

/** The status column: text and color. */
export function agentStatusText(
	agent: SubagentInfo,
	now: number,
): { text: string; color: "success" | "accent" | "warning" | "error" | "muted" | "dim" } {
	const elapsed = agent.startedAt !== undefined ? formatElapsed((agent.endedAt ?? now) - agent.startedAt) : undefined;
	const time = elapsed ? ` · ${elapsed}` : "";
	switch (agent.status) {
		case "done":
			return { text: agent.merged === false ? `✓ done, not merged${time}` : `✓ done${time}`, color: "success" };
		case "running":
			return { text: `● running${time}`, color: "accent" };
		case "waiting_approval":
			return { text: "‖ waiting for approval", color: "warning" };
		case "paused":
			return { text: `‖ paused${time}`, color: "warning" };
		case "queued":
			return {
				text:
					agent.dependsOn.length > 0
						? `○ queued · needs ${agent.dependsOn.map(agentNumber).join(", ")}`
						: "○ queued",
				color: "dim",
			};
		case "failed":
			return { text: `✗ failed${time}`, color: "error" };
		case "stopped":
			return { text: `■ stopped${time}`, color: "muted" };
	}
}

const ACTIVE = new Set(["running", "waiting_approval", "paused"]);

export class AgentsPanelComponent implements Component, Focusable {
	private readonly options: AgentsPanelOptions;
	private selected = 0;
	private mode: Mode = "list";
	private steerInput: Input | undefined;
	private pickIndex = 0;
	private scroll = 0;
	private message: { text: string; warning: boolean } | undefined;
	private readonly unsubscribe: Array<() => void> = [];
	private readonly releaseApprovals: () => void;
	private timer: ReturnType<typeof setInterval> | undefined;
	private closed = false;
	private _focused = false;

	constructor(options: AgentsPanelOptions) {
		this.options = options;
		const { engines } = options;
		this.releaseApprovals = engines.approvals.hold();
		this.unsubscribe.push(
			engines.onEvent(() => options.requestRender()),
			engines.approvals.onChange(() => options.requestRender()),
			engines.onChange(() => {
				if (!engines.engine()) this.close();
				else options.requestRender();
			}),
		);
		const tick = options.tickMs ?? 1000;
		if (tick > 0) {
			this.timer = setInterval(() => {
				if (this.agents().some((agent) => ACTIVE.has(agent.status))) options.requestRender();
			}, tick);
			this.timer.unref?.();
		}
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.steerInput) this.steerInput.focused = value;
	}

	/** For tests: the mode the panel is in. */
	get currentMode(): Mode {
		return this.mode;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private agents(): readonly SubagentInfo[] {
		return this.options.engines.engine()?.list() ?? [];
	}

	private current(): SubagentInfo | undefined {
		const agents = this.agents();
		if (agents.length === 0) return undefined;
		this.selected = Math.min(Math.max(0, this.selected), agents.length - 1);
		return agents[this.selected];
	}

	invalidate(): void {}

	render(width: number): string[] {
		const agents = this.agents();
		const lines: string[] = [];
		const counts = (["running", "done", "queued"] as const)
			.map((status) => {
				const n = agents.filter((agent) =>
					status === "running" ? ACTIVE.has(agent.status) : agent.status === status,
				).length;
				return `${n} ${status}`;
			})
			.join(" · ");
		const task = this.options.task ? clean(this.options.task) : undefined;
		lines.push(
			`${theme.bold("Sub-agents")}${task ? `${theme.fg("dim", "  ·  task: ")}${truncateToWidth(task, 50, "…")}` : ""}${theme.fg("dim", `  ·  ${counts}`)}`,
			theme.fg("muted", "Parallel, each in its own git worktree · checkpoints are git commits kept in this session"),
			"",
		);

		if (agents.length === 0) {
			lines.push(
				"No sub-agents yet in this session.",
				theme.fg(
					"muted",
					"Ask for work that splits into independent parts; the agent starts sub-agents with its agents tool.",
				),
				"",
				theme.fg("muted", "  esc back"),
			);
			return lines.map((line) => truncateToWidth(line, width, ""));
		}

		const agent = this.current()!;
		if (this.mode === "open") {
			lines.push(...this.renderTranscript(agent, width));
			lines.push("", theme.fg("muted", `  ${OPEN_KEYS}`));
			return lines.map((line) => truncateToWidth(line, width, ""));
		}

		const tableWidth = Math.min(width - 2, TABLE_WIDTH);
		lines.push(
			theme.bold(
				theme.fg(
					"dim",
					`   #  ${pad("agent", 13)}${pad("task", 38)}${pad("status", 24)}${padStart("tokens", 8)}${padStart("cost", 9)}`,
				),
			),
			theme.fg("muted", `  ${"─".repeat(tableWidth)}`),
		);
		const now = this.now();
		agents.forEach((row, index) => {
			const selected = index === this.selected;
			const status = agentStatusText(row, now);
			const started = row.status !== "queued" || row.usage.totalTokens > 0;
			const marker = selected ? theme.fg("accent", "❯ ") : "  ";
			const number = selected
				? theme.bold(theme.fg("accent", agentNumber(row.id).padStart(2)))
				: theme.fg("dim", agentNumber(row.id).padStart(2));
			lines.push(
				`${marker}${number}  ${theme.fg("accent", pad(clean(row.label), 13))}${theme.fg("text", pad(clean(row.task), 38))}${theme.fg(status.color, pad(status.text, 24))}${theme.fg("dim", padStart(started ? formatTokenCount(row.usage.totalTokens) : "—", 8))}${theme.fg("text", padStart(started ? formatCost(row.usage.cost.total) : "—", 9))}`,
			);
		});
		lines.push(theme.fg("muted", `  ${"─".repeat(tableWidth)}`));
		lines.push(this.modelsLine(agents));
		lines.push("");

		if (this.mode === "pick") lines.push(...this.renderPick(agent, width));
		else lines.push(...this.renderDetail(agent, width));

		if (this.message) {
			lines.push(
				this.message.warning ? theme.fg("warning", this.message.text) : theme.fg("muted", this.message.text),
			);
		}
		lines.push("");
		if (this.mode === "steer" && this.steerInput) {
			const lead = `steer #${agentNumber(agent.id)} › `;
			const [input = ""] = this.steerInput.render(Math.max(10, width - visibleWidth(lead)));
			lines.push(`${theme.bold(theme.fg("accent", lead))}${input}`, "");
			lines.push(theme.fg("muted", "  enter send · esc back"));
		} else {
			lines.push(theme.fg("muted", `  ${this.mode === "pick" ? PICK_KEYS : AGENTS_PANEL_KEYS}`));
		}
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private modelsLine(agents: readonly SubagentInfo[]): string {
		const parent = this.options.parentModel;
		const childModels = [...new Set(agents.map((agent) => agent.model?.id).filter((id): id is string => !!id))];
		const cheaper = childModels.filter((id) => id !== parent);
		const total = agents.reduce((sum, agent) => sum + agent.usage.cost.total, 0);
		const models =
			cheaper.length > 0
				? `${theme.fg("dim", "  sub-tasks use a cheaper model: ")}${theme.fg("text", cheaper.join(", "))}`
				: theme.fg("dim", "  sub-tasks use the parent's model");
		const parentText = parent ? `${theme.fg("dim", "   ·   parent: ")}${theme.fg("text", parent)}` : "";
		return `${models}${parentText}${theme.fg("dim", "   ·   total ")}${theme.bold(formatCost(total))}`;
	}

	private renderDetail(agent: SubagentInfo, width: number): string[] {
		const rows: string[] = [];
		for (const line of agent.activity ?? [])
			rows.push(`${theme.fg("success", "● ")}${theme.fg("text", clean(line))}`);
		if (agent.pendingApproval) {
			const held = this.options.engines.approvals.isHeld(agent.id);
			rows.push(
				`${theme.fg("warning", "● ")}${theme.fg("text", "Wants to run ")}${theme.bold(clean(agent.pendingApproval.command))}${theme.fg("dim", `  (${clean(agent.pendingApproval.reason)})`)}`,
			);
			if (held) rows.push(theme.fg("dim", "  a opens the approval box"));
		}
		if (agent.summary && !ACTIVE.has(agent.status)) rows.push(theme.fg("text", clean(agent.summary)));
		if (agent.keptWorktree) {
			rows.push(
				`${theme.fg("dim", "worktree  ")}${theme.fg("text", agent.keptWorktree)}${theme.fg("dim", "  ·  x removes it")}`,
			);
		}
		const checkpoints = agent.checkpoints ?? [];
		if (ACTIVE.has(agent.status) || checkpoints.length > 0) {
			const list =
				checkpoints.length > 0
					? checkpoints
							.slice(-4)
							.map((checkpoint) => theme.fg("text", `${checkpoint.id} ${clock(checkpoint.at)}`))
							.join(theme.fg("muted", "  ·  "))
					: theme.fg("dim", "none yet · c keeps one");
			const hint =
				checkpoints.length > 0 && ACTIVE.has(agent.status)
					? theme.fg("dim", "  ·  pause it, then r resumes from any of them")
					: "";
			rows.push(`${theme.fg("dim", "checkpoints  ")}${list}${hint}`);
		}
		if (rows.length === 0)
			rows.push(theme.fg("dim", agent.status === "queued" ? "Not started yet." : "No steps yet."));
		const title = `#${agentNumber(agent.id)} ${clean(agent.label)} · last activity`;
		return renderShellBox(title, rows, Math.min(width, BOX_WIDTH), (text) => theme.fg("accent", text));
	}

	private renderPick(agent: SubagentInfo, width: number): string[] {
		const choices = this.pickChoices(agent);
		const rows = choices.map((choice, index) =>
			index === this.pickIndex
				? theme.bold(theme.fg("accent", `❯ ${choice.label}`))
				: theme.fg("text", `  ${choice.label}`),
		);
		return renderShellBox(
			`Resume #${agentNumber(agent.id)} ${clean(agent.label)} from`,
			rows,
			Math.min(width, BOX_WIDTH),
			(text) => theme.fg("accent", text),
		);
	}

	private pickChoices(agent: SubagentInfo): Array<{ label: string; checkpoint?: string }> {
		return [
			{ label: "where it paused" },
			...[...(agent.checkpoints ?? [])].reverse().map((checkpoint) => ({
				label: `${checkpoint.id} · ${clock(checkpoint.at)} · ${checkpoint.filesChanged ?? 0} files changed`,
				checkpoint: checkpoint.id,
			})),
		];
	}

	private renderTranscript(agent: SubagentInfo, width: number): string[] {
		const transcript: SubagentTranscriptLine[] = this.options.engines.engine()?.transcript(agent.id) ?? [];
		const inner = Math.max(10, Math.min(width, BOX_WIDTH) - 4);
		const rows: string[] = [];
		for (const line of transcript) {
			const style =
				line.kind === "tool"
					? (text: string) => theme.fg("accent", text)
					: line.kind === "tool_result"
						? (text: string) => theme.fg("dim", text)
						: line.kind === "error"
							? (text: string) => theme.fg("error", text)
							: line.kind === "assistant"
								? (text: string) => theme.fg("text", text)
								: (text: string) => theme.bold(theme.fg("text", text));
			const lead =
				line.kind === "tool" ? "→ " : line.kind === "tool_result" ? "  " : line.kind === "assistant" ? "" : "› ";
			for (const part of line.text.split("\n")) {
				const text = clean(part);
				if (!text) continue;
				for (let start = 0; start < text.length; start += inner - 2)
					rows.push(style(`${lead}${text.slice(start, start + inner - 2)}`));
			}
		}
		if (rows.length === 0) rows.push(theme.fg("dim", "Nothing yet."));
		const maxScroll = Math.max(0, rows.length - TRANSCRIPT_ROWS);
		this.scroll = Math.min(this.scroll, maxScroll);
		const end = rows.length - this.scroll;
		const shown = rows.slice(Math.max(0, end - TRANSCRIPT_ROWS), end);
		const status = agentStatusText(agent, this.now());
		return renderShellBox(
			`#${agentNumber(agent.id)} ${clean(agent.label)} · ${status.text}`,
			shown,
			Math.min(width, BOX_WIDTH),
			(text) => theme.fg("accent", text),
		);
	}

	handleInput(data: string): void {
		if (this.closed) return;
		const kb = getKeybindings();
		if (this.mode === "steer" && this.steerInput) {
			this.steerInput.handleInput(data);
			this.options.requestRender();
			return;
		}
		const agents = this.agents();
		if (this.mode === "open") {
			if (kb.matches(data, "tui.select.cancel")) this.mode = "list";
			else if (kb.matches(data, "tui.select.up")) this.scroll++;
			else if (kb.matches(data, "tui.select.down")) this.scroll = Math.max(0, this.scroll - 1);
			this.options.requestRender();
			return;
		}
		if (this.mode === "pick") {
			const agent = this.current();
			const choices = agent ? this.pickChoices(agent) : [];
			if (kb.matches(data, "tui.select.cancel")) this.mode = "list";
			else if (kb.matches(data, "tui.select.up"))
				this.pickIndex = (this.pickIndex + choices.length - 1) % Math.max(1, choices.length);
			else if (kb.matches(data, "tui.select.down"))
				this.pickIndex = (this.pickIndex + 1) % Math.max(1, choices.length);
			else if ((kb.matches(data, "tui.select.confirm") || data === "\n") && agent) {
				this.mode = "list";
				void this.resume(agent, choices[this.pickIndex]?.checkpoint);
			}
			this.options.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.close();
			return;
		}
		if (agents.length === 0) return;
		const agent = this.current()!;
		if (kb.matches(data, "tui.select.up")) {
			this.selected = (this.selected + agents.length - 1) % agents.length;
			this.message = undefined;
		} else if (kb.matches(data, "tui.select.down")) {
			this.selected = (this.selected + 1) % agents.length;
			this.message = undefined;
		} else if (kb.matches(data, "tui.select.confirm") || data === "\n") {
			this.mode = "open";
			this.scroll = 0;
		} else if (data === "a") {
			if (this.options.engines.approvals.release(agent.id))
				this.say(`#${agentNumber(agent.id)}'s approval box is open.`);
			else if (agent.status === "waiting_approval")
				this.say(`#${agentNumber(agent.id)}'s approval box is already open; answer it first.`, true);
			else this.say(`#${agentNumber(agent.id)} is not waiting for an approval.`, true);
		} else if (data === "s") {
			if (!ACTIVE.has(agent.status))
				this.say(`#${agentNumber(agent.id)} is not running, so it cannot be steered.`, true);
			else this.startSteer(agent);
		} else if (data === "p") {
			if (this.engine()?.pause(agent.id))
				this.say(`Pausing #${agentNumber(agent.id)}: it holds before its next model call.`);
			else
				this.say(
					agent.status === "paused"
						? `#${agentNumber(agent.id)} is paused already.`
						: `#${agentNumber(agent.id)} is not running.`,
					true,
				);
		} else if (data === "k") {
			if (this.engine()?.stop(agent.id)) this.say(`Stopping #${agentNumber(agent.id)}.`);
			else this.say(`#${agentNumber(agent.id)} is not running or queued.`, true);
		} else if (data === "c") {
			void this.checkpoint(agent);
		} else if (data === "r") {
			if (agent.status !== "paused") this.say(`#${agentNumber(agent.id)} is not paused; p pauses it.`, true);
			else if ((agent.checkpoints ?? []).length > 0) {
				this.mode = "pick";
				this.pickIndex = 0;
			} else void this.resume(agent, undefined);
		} else if (data === "x") {
			void this.removeWorktree(agent);
		}
		this.options.requestRender();
	}

	private engine() {
		return this.options.engines.engine();
	}

	private say(text: string, warning = false): void {
		this.message = { text, warning };
		this.options.requestRender();
	}

	private startSteer(agent: SubagentInfo): void {
		const input = new Input({ prompt: "" });
		input.focused = this._focused;
		input.onSubmit = (value) => {
			const message = value.trim();
			this.steerInput = undefined;
			this.mode = "list";
			if (!message) return;
			if (this.engine()?.steer(agent.id, message))
				this.say(`Sent to #${agentNumber(agent.id)}; it reads it before its next model call.`);
			else this.say(`#${agentNumber(agent.id)} is not running.`, true);
		};
		input.onEscape = () => {
			this.steerInput = undefined;
			this.mode = "list";
			this.options.requestRender();
		};
		this.steerInput = input;
		this.mode = "steer";
	}

	private async checkpoint(agent: SubagentInfo): Promise<void> {
		const engine = this.engine();
		if (!engine) return;
		this.say(`Keeping a checkpoint of #${agentNumber(agent.id)} at its next model call…`);
		try {
			const checkpoint = await engine.checkpoint(agent.id);
			this.say(
				`Kept ${checkpoint.id} of #${agentNumber(agent.id)} (${checkpoint.filesChanged ?? 0} files changed).`,
			);
		} catch (error) {
			this.say(error instanceof Error ? error.message : String(error), true);
		}
	}

	private async resume(agent: SubagentInfo, checkpoint: string | undefined): Promise<void> {
		const engine = this.engine();
		if (!engine) return;
		if (checkpoint) this.say(`Rolling #${agentNumber(agent.id)} back to ${checkpoint}…`);
		try {
			await engine.resume(agent.id, checkpoint);
			this.say(
				checkpoint ? `#${agentNumber(agent.id)} goes on from ${checkpoint}.` : `#${agentNumber(agent.id)} goes on.`,
			);
		} catch (error) {
			this.say(error instanceof Error ? error.message : String(error), true);
		}
	}

	private async removeWorktree(agent: SubagentInfo): Promise<void> {
		const engine = this.engine();
		if (!engine) return;
		try {
			await engine.removeWorktree(agent.id);
			this.say(`Removed the worktree #${agentNumber(agent.id)} kept.`);
		} catch (error) {
			this.say(error instanceof Error ? error.message : String(error), true);
		}
	}

	/** Closes the panel; held approval questions go to the approval box. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.dispose();
		this.options.onClose();
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		for (const stop of this.unsubscribe.splice(0)) stop();
		this.releaseApprovals();
	}
}
