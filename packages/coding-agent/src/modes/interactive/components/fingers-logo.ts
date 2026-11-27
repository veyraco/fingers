import { backgroundAnsi, foregroundAnsi, isAppleTerminalSession, type RgbColor, rgbColor } from "@veyraco/fingers-tui";
import { theme } from "../theme/theme.ts";

/** The Fingers mark's colors (canvas Foundations → Logo). They stay fixed across themes. */
const FINGERS_MARK_COLORS = {
	yellow: rgbColor(0xfd, 0xd6, 0x63),
	green: rgbColor(0x81, 0xc9, 0x95),
	blue: rgbColor(0x8a, 0xb4, 0xf8),
	red: rgbColor(0xf2, 0x8b, 0x82),
} as const satisfies Record<string, RgbColor>;

type MarkPixel = keyof typeof FINGERS_MARK_COLORS | undefined;

const Y = "yellow" as const;
const G = "green" as const;
const B = "blue" as const;
const R = "red" as const;
const _ = undefined;

/**
 * The Fingers mark as square pixels: the green hook and blue stem of an "f", the yellow crossbar, and the
 * red fingertip dot top right. Two pixel rows share one terminal line through half blocks.
 */
export const FINGERS_MARK_PIXELS: readonly (readonly MarkPixel[])[] = [
	[_, _, _, G, G, _, R],
	[_, _, G, _, _, _, _],
	[_, Y, B, Y, Y, _, _],
	[_, _, B, _, _, _, _],
	[_, _, B, _, _, _, _],
	[_, _, B, _, _, _, _],
];

const RESET = "\x1b[0m";

function cell(top: MarkPixel, bottom: MarkPixel, fg: (pixel: NonNullable<MarkPixel>) => string): string {
	if (!top && !bottom) return " ";
	if (top && bottom && top === bottom) return `${fg(top)}█${RESET}`;
	if (top && !bottom) return `${fg(top)}▀${RESET}`;
	if (!top && bottom) return `${fg(bottom)}▄${RESET}`;
	// Two colors in one cell: the top pixel is the glyph, the bottom one its background.
	const bg = backgroundAnsi(FINGERS_MARK_COLORS[bottom!], theme.getColorMode());
	return `${fg(top!)}${bg}▀${RESET}`;
}

/** The mark as three terminal lines, one cell per pixel column. */
function fingersMarkLines(): string[] {
	const mode = theme.getColorMode();
	const fg = (pixel: NonNullable<MarkPixel>) => foregroundAnsi(FINGERS_MARK_COLORS[pixel], mode);
	const lines: string[] = [];
	for (let row = 0; row < FINGERS_MARK_PIXELS.length; row += 2) {
		const top = FINGERS_MARK_PIXELS[row];
		const bottom = FINGERS_MARK_PIXELS[row + 1] ?? [];
		lines.push(top.map((pixel, column) => cell(pixel, bottom[column], fg)).join(""));
	}
	return lines;
}

/**
 * Whether the terminal renders the half-block mark correctly. Apple Terminal draws gaps between rows and
 * misaligns the half blocks, so it gets the text wordmark instead.
 */
function supportsFingersLogo(): boolean {
	return !isAppleTerminalSession();
}

/** The product name as on the canvas banner: "Veyra" bold, then "Fingers". */
function fingersWordmark(): string {
	return `${theme.bold(theme.fg("text", "Veyra"))}${theme.fg("text", " Fingers")}`;
}

interface FingersBannerOptions {
	version: string;
	/** Second line, after the version, e.g. "coding agent harness" or "first run". */
	subtitle?: string;
	/** Third line (key hints); empty when omitted. */
	hints?: string;
	/** Draw the half-block mark; otherwise only the text lines. Defaults to supportsFingersLogo(). */
	showMark?: boolean;
}

/** The startup banner (canvas FingersTui): mark, wordmark, version line, and an optional hint line. */
export function fingersBannerLines(options: FingersBannerOptions): string[] {
	const subtitle = [`v${options.version}`, options.subtitle ?? "coding agent harness"].join(" · ");
	const text = [fingersWordmark(), theme.fg("muted", subtitle), options.hints ?? ""];
	if (!(options.showMark ?? supportsFingersLogo())) return options.hints ? text : text.slice(0, 2);
	const mark = fingersMarkLines();
	return text.map((line, index) => (line ? `${mark[index]}  ${line}` : mark[index])).map((line) => line.trimEnd());
}
