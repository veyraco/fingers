/**
 * Utilities for formatting keybinding hints in the UI.
 */

import { getKeybindings, type Keybinding, type KeyId } from "@veyraco/fingers-tui";
import { theme } from "../theme/theme.ts";

interface KeyTextFormatOptions {
	capitalize?: boolean;
}

function formatKeyPart(part: string, options: KeyTextFormatOptions): string {
	const displayPart = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
	return options.capitalize ? displayPart.charAt(0).toUpperCase() + displayPart.slice(1) : displayPart;
}

export function formatKeyText(key: string, options: KeyTextFormatOptions = {}): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => formatKeyPart(part, options))
				.join("+"),
		)
		.join("/");
}

function formatKeys(keys: KeyId[], options: KeyTextFormatOptions = {}): string {
	if (keys.length === 0) return "";
	return formatKeyText(keys.join("/"), options);
}

export function keyText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding));
}

export function keyDisplayText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding), { capitalize: true });
}

export function keyHint(keybinding: Keybinding, description: string): string {
	return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
}

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);
}

/** The first key of an action, short as the canvas writes it (`esc`), or `fallback` when it has none. */
export function shortKeyText(keybinding: Keybinding, fallback: string): string {
	const first = getKeybindings().getKeys(keybinding)[0];
	if (!first) return fallback;
	return formatKeyText(first === "escape" ? "esc" : first);
}

/** The hint line under the editor (canvas FingersTuiSession): enter send · shift+enter newline · … */
export function editorHintLine(): string {
	return [
		`${shortKeyText("tui.input.submit", "enter")} send`,
		`${shortKeyText("tui.input.newLine", "shift+enter")} newline`,
		"/ commands",
		"@ files",
		`${shortKeyText("app.interrupt", "esc")} interrupt`,
	].join(" · ");
}
