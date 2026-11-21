import { truncateToWidth, visibleWidth } from "@veyraco/fingers-tui";
import { theme } from "../theme/theme.ts";

/**
 * A titled box with rounded corners, as the canvas draws the Fingers terminal's boxes ("Open core",
 * "Approval needed", "Commands"): `╭─ Title ───╮`, `│ row │`, `╰───╯`. The box is as wide as its widest
 * row needs, at most `maxWidth`; rows that do not fit are truncated.
 */
export function renderShellBox(
	title: string,
	rows: readonly string[],
	maxWidth: number,
	color: (text: string) => string,
): string[] {
	const contentWidth = Math.max(visibleWidth(title) + 2, ...rows.map((row) => visibleWidth(row)));
	const width = Math.max(8, Math.min(maxWidth, contentWidth + 4));
	const inner = width - 4;
	const titleText = truncateToWidth(title, Math.max(1, width - 6), "");
	const lines = [
		`${color("╭─ ")}${theme.bold(color(titleText))}${color(` ${"─".repeat(Math.max(0, width - visibleWidth(titleText) - 5))}╮`)}`,
	];
	for (const row of rows) {
		const text = truncateToWidth(row, inner, "…");
		lines.push(`${color("│ ")}${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))}${color(" │")}`);
	}
	lines.push(color(`╰${"─".repeat(width - 2)}╯`));
	return lines;
}
