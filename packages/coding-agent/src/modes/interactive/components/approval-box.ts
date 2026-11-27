/**
 * The approval box (canvas FingersTuiSession): "Approval needed · run a command", the command, why it asks,
 * and three answers: Yes, Yes always allow "<prefix>", No and tell Fingers what to do instead.
 *
 * The person approves what they see, so no text is dropped: long commands wrap across rows instead of
 * being cut off, every line of a multi-line command gets its own rows, and control and bidirectional
 * characters are shown as visible placeholders instead of acting on the terminal. A command longer
 * than MAX_COMMAND_ROWS rows shows its start and its end around a "… N more rows · v shows all" row,
 * so the answers stay on the screen; v shows every row and folds them again.
 * The keys (←→, enter, y, a, n, v, esc) are not listed under the box, as on the artboard.
 */
import { type Component, type Focusable, getKeybindings, Input, visibleWidth } from "@veyraco/fingers-tui";
import { theme } from "../theme/theme.ts";
import { renderShellBox } from "./shell-box.ts";

export type ApprovalAnswer =
	| { decision: "allow_once" }
	| { decision: "allow_always" }
	| { decision: "deny"; message?: string };

interface ApprovalBoxOptions {
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
/** Command rows shown before the middle is folded: the box then fits a 36-row terminal with room to spare. */
const MAX_COMMAND_ROWS = 20;
/** Of the folded rows, how many come from the end of the command (where a last step could hide). */
const FOLDED_TAIL_ROWS = 7;
/** The box's border and padding: `│ ` and ` │`. */
const BOX_CHROME = 4;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Bidirectional overrides and invisible characters that could make the shown text differ from what runs. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

/**
 * Makes `text` safe to show as one line: control characters become their Unicode control pictures
 * (ESC → ␛, CR → ␍, tab → ␉) and invisible or bidi characters become `<U+202E>`.
 */
function visibleCommandText(text: string): string {
	return text
		.replace(/[\u0000-\u001F\u007F]/g, (char) =>
			char === "\u007F" ? "␡" : String.fromCharCode(0x2400 + char.charCodeAt(0)),
		)
		.replace(INVISIBLE, (char) => `<U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}>`);
}

/** Splits plain `text` into pieces at most `width` cells wide, keeping every character. */
function hardWrap(text: string, width: number): string[] {
	const pieces: string[] = [];
	let current = "";
	let currentWidth = 0;
	for (const { segment } of graphemes.segment(text)) {
		const segmentWidth = visibleWidth(segment);
		if (currentWidth + segmentWidth > width && current) {
			pieces.push(current);
			current = "";
			currentWidth = 0;
		}
		current += segment;
		currentWidth += segmentWidth;
	}
	if (current || pieces.length === 0) pieces.push(current);
	return pieces;
}

export class ApprovalBoxComponent implements Component, Focusable {
	private readonly options: ApprovalBoxOptions;
	private choice = 0;
	private input: Input | undefined;
	private answered = false;
	private expanded = false;
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
		const boxWidth = Math.min(width, MAX_BOX_WIDTH);
		const inner = Math.max(1, boxWidth - BOX_CHROME);
		const rows: string[] = [];

		// The command: "$ " on its first row, continuation rows indented under it.
		const indent = isCommand ? 2 : 0;
		const commandRows: string[] = [];
		summary.split("\n").forEach((line, lineIndex) => {
			hardWrap(visibleCommandText(line), Math.max(1, inner - indent)).forEach((piece, pieceIndex) => {
				const lead = !isCommand ? "" : lineIndex === 0 && pieceIndex === 0 ? theme.fg("muted", "$ ") : "  ";
				commandRows.push(`${lead}${theme.bold(theme.fg("text", piece))}`);
			});
		});
		if (commandRows.length <= MAX_COMMAND_ROWS) {
			rows.push(...commandRows);
		} else if (this.expanded) {
			rows.push(...commandRows, theme.fg("muted", "v folds the command"));
		} else {
			// Start and end of the command around one row that says how much is folded.
			const head = MAX_COMMAND_ROWS - 1 - FOLDED_TAIL_ROWS;
			const hidden = commandRows.length - head - FOLDED_TAIL_ROWS;
			rows.push(
				...commandRows.slice(0, head),
				theme.fg("warning", `… ${hidden} more rows · v shows all`),
				...commandRows.slice(-FOLDED_TAIL_ROWS),
			);
		}
		rows.push(theme.fg("muted", reason), "");

		// The answers on one row when they fit, otherwise one per row, wrapped.
		const labels = [
			"Yes",
			`Yes, always allow “${visibleCommandText(allowPattern)}”`,
			"No, tell Fingers what to do instead",
		];
		const style = (index: number, text: string) =>
			index === this.choice ? theme.bold(theme.fg("accent", text)) : theme.fg("text", text);
		const marked = labels.map((label, index) => (index === this.choice ? `❯ ${label}` : label));
		const oneRow = marked.join("    ");
		if (visibleWidth(oneRow) <= inner) {
			rows.push(marked.map((label, index) => style(index, label)).join("    "));
		} else {
			marked.forEach((label, index) => {
				const lead = index === this.choice ? "" : "  ";
				for (const piece of hardWrap(`${lead}${label}`, inner)) rows.push(style(index, piece));
			});
		}

		if (this.input) {
			const inputWidth = Math.max(10, inner - 15);
			const [inputLine = ""] = this.input.render(inputWidth);
			rows.push("", `${theme.bold(theme.fg("accent", "tell Fingers › "))}${inputLine}`);
		}
		return renderShellBox(`Approval needed · ${action}`, rows, boxWidth, (text) => theme.fg("warning", text));
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
		} else if (data === "v") {
			this.expanded = !this.expanded;
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
