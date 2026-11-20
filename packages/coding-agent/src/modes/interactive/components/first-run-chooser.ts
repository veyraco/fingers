/**
 * The first-run screen (canvas "Fingers · CLI & web", FingersTuiFirstRun): how Fingers gets a model when
 * none is configured. 1 signs in to Veyra, 2 stores an API key for the chosen provider, 3 uses keys from
 * the environment. "Found on this machine" lists what detectLocalCredentials() saw (names, never values).
 */
import { type Component, getKeybindings, truncateToWidth, visibleWidth } from "@veyraco/fingers-tui";
import {
	type DetectedCredential,
	FIRST_RUN_PROVIDERS,
	type FirstRunProvider,
} from "../../../core/first-run-providers.ts";
import { theme } from "../theme/theme.ts";
import { fingersBannerLines } from "./fingers-logo.ts";
import { renderShellBox } from "./shell-box.ts";

export type FirstRunChoice =
	| { kind: "veyra" }
	| { kind: "api_key"; provider: FirstRunProvider }
	| { kind: "env"; detected: readonly DetectedCredential[] };

export interface FirstRunChooserOptions {
	version: string;
	detected: readonly DetectedCredential[];
	providers?: readonly FirstRunProvider[];
	onChoose: (choice: FirstRunChoice) => void;
	onCancel: () => void;
}

const OPTIONS = [
	{
		label: "Sign in to Veyra",
		detail: "fingers login · use your org’s model connections from Veyra Connect, ee features by tier",
	},
	{ label: "Use an API key", detail: "stored in your OS keychain, never leaves this machine" },
	{
		label: "Use environment keys",
		detail: "read ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY …",
	},
] as const;

/** "❯ 1  Sign in to Veyra" padded so the details line up (canvas column). */
const OPTION_HEAD_WIDTH = 28;
const PROVIDERS_PER_ROW = 6;
const LEFT_PAD = " ";

const SHORT_PROVIDER_LABELS: Readonly<Record<string, string>> = {
	"Amazon Bedrock": "Bedrock",
	"Google Vertex AI": "Vertex AI",
};

/** `ANTHROPIC_API_KEY`, or `~/.aws profile "dev" (Bedrock)` when the source does not name the provider. */
export function formatDetectedCredential(found: DetectedCredential): string {
	if (/^[A-Z0-9_]+$/.test(found.source)) return found.source;
	return `${found.source} (${SHORT_PROVIDER_LABELS[found.label] ?? found.label})`;
}

export class FirstRunChooserComponent implements Component {
	private readonly options: FirstRunChooserOptions;
	private readonly providers: readonly FirstRunProvider[];
	private optionIndex = 0;
	private providerIndex = 0;
	private showHelp = false;
	private notice: string[] = [];

	constructor(options: FirstRunChooserOptions) {
		this.options = options;
		this.providers = options.providers ?? FIRST_RUN_PROVIDERS;
	}

	/** Lines shown under the options, e.g. why a choice cannot finish yet. Empty clears them. */
	setNotice(lines: string[]): void {
		this.notice = lines;
	}

	get selectedOption(): 1 | 2 | 3 {
		return (this.optionIndex + 1) as 1 | 2 | 3;
	}

	get selectedProvider(): FirstRunProvider {
		return this.providers[this.providerIndex]!;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const inner = Math.max(1, width - LEFT_PAD.length);
		const out: string[] = [""];
		out.push(...fingersBannerLines({ version: this.options.version, subtitle: "coding agent harness · first run" }));
		out.push("");
		out.push(theme.fg("text", "Fingers needs a model to work with. How do you want to connect?"));
		out.push("");
		OPTIONS.forEach((option, index) => {
			const selected = index === this.optionIndex;
			const head = `${selected ? "❯" : " "} ${index + 1}  ${option.label}`.padEnd(OPTION_HEAD_WIDTH);
			const line = selected
				? `${theme.bold(theme.fg("accent", head))}${theme.fg("text", option.detail)}`
				: `${theme.bold(theme.fg("text", head))}${theme.fg("muted", option.detail)}`;
			out.push(selected ? theme.bg("selectedBg", padTo(line, inner)) : line);
		});
		if (this.notice.length > 0) {
			out.push("");
			for (const line of this.notice) out.push(theme.fg("warning", line));
		}
		out.push("");
		out.push(theme.fg("muted", "Provider for option 2"));
		out.push(...this.renderProviderRows());
		out.push("");
		out.push(this.renderFound());
		out.push("");
		out.push(
			...renderShellBox(
				"Open core",
				[
					theme.fg(
						"text",
						"The MIT core works without an account: chat, tools, edits, approvals, MCP, skills, hooks.",
					),
					`${theme.fg("muted", "Token saving, sub-agents, checkpoints, Brain memory and Eyes telemetry live in ")}${theme.fg("warning", "ee/")}${theme.fg("muted", " and switch")}`,
					`${theme.fg("muted", "on after ")}${theme.fg("accent", "fingers login")}${theme.fg("muted", " when your organization’s Veyra tier includes them.")}`,
				],
				inner,
				(text) => theme.fg("dim", text),
			),
		);
		out.push("");
		if (this.showHelp) {
			out.push(
				theme.fg(
					"muted",
					"1 signs in with your Veyra account. 2 asks for the key of the provider picked with ←→ and keeps it",
				),
			);
			out.push(
				theme.fg("muted", "in your OS keychain. 3 uses keys already set in your shell. /login changes this later."),
			);
			out.push("");
		}
		out.push(theme.fg("dim", "↑↓ choose · enter confirm · ? help · esc quit"));
		return out.map((line) => (line ? truncateToWidth(`${LEFT_PAD}${line}`, width, "") : ""));
	}

	private renderProviderRows(): string[] {
		const cells = this.providers.map(
			(provider, index) => `${index === this.providerIndex ? "●" : "○"} ${provider.label}`,
		);
		// A cell that ends its row is not padded, so it does not widen its column.
		const endsRow = (index: number) =>
			index % PROVIDERS_PER_ROW === PROVIDERS_PER_ROW - 1 || index === cells.length - 1;
		const columnWidths: number[] = [];
		cells.forEach((cell, index) => {
			if (endsRow(index)) return;
			const column = index % PROVIDERS_PER_ROW;
			columnWidths[column] = Math.max(columnWidths[column] ?? 0, visibleWidth(cell) + 3);
		});
		const rows: string[] = [];
		for (let start = 0; start < cells.length; start += PROVIDERS_PER_ROW) {
			const row = cells.slice(start, start + PROVIDERS_PER_ROW).map((cell, offset) => {
				const index = start + offset;
				const padded =
					offset === PROVIDERS_PER_ROW - 1 || index === cells.length - 1
						? cell
						: cell.padEnd(columnWidths[offset]!);
				const active = index === this.providerIndex && this.optionIndex === 1;
				return active ? theme.bold(theme.fg("accent", padded)) : theme.fg("text", padded);
			});
			rows.push(`  ${row.join("")}`);
		}
		return rows;
	}

	private renderFound(): string {
		const label = theme.fg("muted", "Found on this machine  ");
		if (this.options.detected.length === 0) return `${label}${theme.fg("dim", "no provider keys or profiles")}`;
		return `${label}${this.options.detected.map((found) => theme.fg("success", `${formatDetectedCredential(found)} ✓`)).join("   ")}`;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up") || data === "k") {
			this.optionIndex = (this.optionIndex + OPTIONS.length - 1) % OPTIONS.length;
		} else if (kb.matches(data, "tui.select.down") || data === "j") {
			this.optionIndex = (this.optionIndex + 1) % OPTIONS.length;
		} else if (data === "1" || data === "2" || data === "3") {
			this.optionIndex = Number(data) - 1;
		} else if (kb.matches(data, "tui.editor.cursorLeft") || data === "h") {
			this.optionIndex = 1;
			this.providerIndex = (this.providerIndex + this.providers.length - 1) % this.providers.length;
		} else if (kb.matches(data, "tui.editor.cursorRight") || data === "l") {
			this.optionIndex = 1;
			this.providerIndex = (this.providerIndex + 1) % this.providers.length;
		} else if (data === "?") {
			this.showHelp = !this.showHelp;
		} else if (kb.matches(data, "tui.select.confirm") || data === "\n") {
			this.notice = [];
			this.options.onChoose(this.currentChoice());
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.options.onCancel();
		}
	}

	private currentChoice(): FirstRunChoice {
		if (this.optionIndex === 0) return { kind: "veyra" };
		if (this.optionIndex === 1) return { kind: "api_key", provider: this.selectedProvider };
		return { kind: "env", detected: this.options.detected };
	}
}

function padTo(line: string, width: number): string {
	return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
}
