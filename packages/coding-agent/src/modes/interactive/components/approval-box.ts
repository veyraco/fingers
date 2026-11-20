/**
 * The approval box (canvas FingersTuiSession): "Approval needed · run a command", the command, why it asks,
 * and three answers: Yes, Yes always allow "<prefix>", No and tell Fingers what to do instead.
 */
import { type Component, type Focusable, getKeybindings, Input } from "@veyraco/fingers-tui";
import { theme } from "../theme/theme.ts";
import { renderShellBox } from "./shell-box.ts";

export type ApprovalAnswer =
	| { decision: "allow_once" }
	| { decision: "allow_always" }
	| { decision: "deny"; message?: string };

export interface ApprovalBoxOptions {
	/** Title after "Approval needed · ", e.g. "run a command". */
	action: string;
	/** What runs, e.g. the command line. Shown after "$ " for commands. */
	summary: string;
	/** Show the summary as a shell command (`$ ` prefix). */
	isCommand: boolean;
	/** Why it asks, e.g. "Not in your allow list." */
	reason: string;
	/** What "always allow" adds, e.g. `pnpm vitest`. */
	allowPattern: string;
	onAnswer: (answer: ApprovalAnswer) => void;
}

const MAX_BOX_WIDTH = 100;

export class ApprovalBoxComponent implements Component, Focusable {
	private readonly options: ApprovalBoxOptions;
	private choice = 0;
	private input: Input | undefined;
	private answered = false;
	private _focused = false;

	constructor(options: ApprovalBoxOptions) {
		this.options = options;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.input) this.input.focused = value;
	}

	/** 0 Yes, 1 always allow, 2 No and tell Fingers. */
	get selectedChoice(): number {
		return this.choice;
	}

	get isTellingFingers(): boolean {
		return this.input !== undefined;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { action, summary, isCommand, reason, allowPattern } = this.options;
		const labels = ["Yes", `Yes, always allow “${allowPattern}”`, "No, tell Fingers what to do instead"];
		const answers = labels
			.map((label, index) =>
				index === this.choice ? theme.bold(theme.fg("accent", `❯ ${label}`)) : theme.fg("text", label),
			)
			.join("    ");
		const rows = [
			isCommand
				? `${theme.fg("muted", "$ ")}${theme.bold(theme.fg("text", summary))}`
				: theme.bold(theme.fg("text", summary)),
			theme.fg("muted", reason),
			"",
			answers,
		];
		if (this.input) {
			const inputWidth = Math.max(10, Math.min(width, MAX_BOX_WIDTH) - 4 - 14);
			const [inputLine = ""] = this.input.render(inputWidth);
			rows.push("", `${theme.bold(theme.fg("accent", "tell Fingers › "))}${inputLine}`);
		}
		const lines = renderShellBox(`Approval needed · ${action}`, rows, Math.min(width, MAX_BOX_WIDTH), (text) =>
			theme.fg("warning", text),
		);
		const hint = this.input
			? "enter send · esc back"
			: "←→ choose · enter confirm · y yes · a always · n tell Fingers · esc no";
		lines.push(theme.fg("dim", hint));
		return lines;
	}

	handleInput(data: string): void {
		if (this.answered) return;
		const kb = getKeybindings();
		if (this.input) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.input = undefined;
				return;
			}
			this.input.handleInput(data);
			return;
		}
		if (kb.matches(data, "tui.editor.cursorLeft") || kb.matches(data, "tui.select.up")) {
			this.choice = (this.choice + 2) % 3;
		} else if (kb.matches(data, "tui.editor.cursorRight") || kb.matches(data, "tui.select.down") || data === "\t") {
			this.choice = (this.choice + 1) % 3;
		} else if (data === "y") {
			this.finish({ decision: "allow_once" });
		} else if (data === "a") {
			this.finish({ decision: "allow_always" });
		} else if (data === "n") {
			this.choice = 2;
			this.startTelling();
		} else if (kb.matches(data, "tui.select.confirm") || data === "\n") {
			if (this.choice === 0) this.finish({ decision: "allow_once" });
			else if (this.choice === 1) this.finish({ decision: "allow_always" });
			else this.startTelling();
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.finish({ decision: "deny" });
		}
	}

	private startTelling(): void {
		const input = new Input();
		input.focused = this._focused;
		input.onSubmit = (value) => {
			const message = value.trim();
			this.finish(message ? { decision: "deny", message } : { decision: "deny" });
		};
		input.onEscape = () => {
			this.input = undefined;
		};
		this.input = input;
	}

	private finish(answer: ApprovalAnswer): void {
		if (this.answered) return;
		this.answered = true;
		this.options.onAnswer(answer);
	}
}
