/**
 * `/login` in the terminal app: the Veyra device-code sign-in in place of the editor, after the canvas artboard
 * FingersTuiLogin. The code waits for the person to confirm it at Veyra Connect; c copies the code, o opens the link
 * again, esc cancels the sign-in.
 */
import {
	type Component,
	type Focusable,
	getKeybindings,
	replaceControlCharacters,
	truncateToWidth,
} from "@veyraco/fingers-tui";
import type { DeviceCodePrompt } from "../../../core/veyra/device-flow.ts";
import {
	CHECK_CODE_STEP,
	formatCountdown,
	SIGN_IN_LEAD,
	type SignedInFacts,
	SPINNER_FRAMES,
	safeSignedInFacts,
	WAITING_TEXT,
} from "../../../core/veyra/login-text.ts";
import { theme } from "../theme/theme.ts";
import { shortKeyText } from "./keybinding-hints.ts";

interface VeyraLoginDialogOptions {
	requestRender(): void;
	/** Esc: the sign-in is aborted through `signal`, then this runs. */
	onCancel(): void;
	openUrl(url: string): void;
	copy(text: string): Promise<void>;
	now?: () => number;
}

/** "✓ Signed in as ada@example.com  ·  org Acme Robotics  ·  tier medium", colored as on the artboard. */
export function formatSignedInLine(unsafeFacts: SignedInFacts): string {
	// Names come from Connect: no terminal escapes reach the screen.
	const facts = safeSignedInFacts(unsafeFacts);
	const separator = theme.fg("dim", "  ·  ");
	let line = `${theme.bold(theme.fg("success", "✓"))} ${theme.fg("text", "Signed in as ")}${theme.bold(
		theme.fg("text", facts.email ?? facts.subject ?? "your Veyra account"),
	)}`;
	if (facts.orgName) line += `${separator}${theme.fg("dim", "org ")}${theme.bold(theme.fg("text", facts.orgName))}`;
	if (facts.tier) line += `${separator}${theme.fg("dim", "tier ")}${theme.fg("text", facts.tier)}`;
	return line;
}

/** "c copy code · o open the link again · esc cancel" with the configured keys (canvas KEY_HINTS by default). */
function keyHints(): string {
	return [
		`${shortKeyText("app.veyra.copyCode", "c")} copy code`,
		`${shortKeyText("app.veyra.openLink", "o")} open the link again`,
		`${shortKeyText("tui.select.cancel", "esc")} cancel`,
	].join(" · ");
}

export class VeyraLoginDialogComponent implements Component, Focusable {
	focused = false;
	private readonly options: VeyraLoginDialogOptions;
	private readonly abortController = new AbortController();
	private prompt: DeviceCodePrompt | undefined;
	private browserOpened = false;
	private deadline = 0;
	private frame = 0;
	private notice: string | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(options: VeyraLoginDialogOptions) {
		this.options = options;
	}

	/** Aborted when the person presses esc. */
	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	showCode(prompt: DeviceCodePrompt, state: { browserOpened: boolean }): void {
		const now = this.options.now ?? Date.now;
		this.prompt = prompt;
		this.browserOpened = state.browserOpened;
		this.deadline = now() + prompt.expiresInSeconds * 1000;
		if (!this.timer) {
			this.timer = setInterval(() => {
				this.frame++;
				this.options.requestRender();
			}, 1000);
			this.timer.unref?.();
		}
		this.options.requestRender();
	}

	/** The browser could not be launched: ask the person to open the address instead of saying it opened. */
	browserDidNotOpen(): void {
		this.browserOpened = false;
		this.options.requestRender();
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const clip = (line: string) => truncateToWidth(line, width, theme.fg("dim", "..."));
		const prompt = this.prompt;
		if (!prompt) {
			return [border, "", clip(theme.fg("muted", "Asking Veyra Connect for a sign-in code…")), "", border];
		}
		const now = this.options.now ?? Date.now;
		const url = replaceControlCharacters(prompt.verificationUri);
		// The same words as `fingers login`, with the address in the accent color.
		const stepLine = this.browserOpened
			? `  ${theme.fg("dim", "1. Your browser opened ")}${theme.fg("accent", url)}`
			: `  ${theme.fg("dim", "1. Open ")}${theme.fg("accent", url)}${theme.fg("dim", " in a browser")}`;
		const spinner = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];
		const lines = [
			border,
			"",
			clip(theme.fg("text", SIGN_IN_LEAD)),
			"",
			clip(stepLine),
			clip(`  ${theme.fg("dim", CHECK_CODE_STEP)}`),
			"",
			clip(`     ${theme.bold(theme.fg("warning", replaceControlCharacters(prompt.userCode)))}`),
			"",
			clip(
				`${theme.fg("accent", spinner)} ${theme.fg("text", WAITING_TEXT)}${theme.fg(
					"dim",
					`   code expires in ${formatCountdown(this.deadline - now())}`,
				)}`,
			),
			clip(`  ${theme.fg("muted", keyHints())}`),
		];
		if (this.notice) lines.push(clip(`  ${theme.fg("dim", this.notice)}`));
		lines.push("", border);
		return lines;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.dispose();
			this.abortController.abort();
			this.options.onCancel();
			return;
		}
		const prompt = this.prompt;
		if (!prompt) return;
		if (kb.matches(data, "app.veyra.copyCode")) {
			this.notice = "Copying the code…";
			void this.options
				.copy(prompt.userCode)
				.then(() => {
					this.notice = "Code copied to the clipboard";
				})
				.catch(() => {
					this.notice = "Could not copy: type the code by hand";
				})
				.finally(() => this.options.requestRender());
			this.options.requestRender();
		} else if (kb.matches(data, "app.veyra.openLink")) {
			this.options.openUrl(prompt.verificationUriComplete ?? prompt.verificationUri);
			this.notice = "Opened the link in your browser";
			this.options.requestRender();
		}
	}
}
