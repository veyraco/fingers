/**
 * The locked box (canvas FingersTuiLocked): an ee command such as /agents while its feature is off. It says which
 * feature it is, why it is off and that the MIT core keeps working, and offers to sign in when signing in can help.
 * ←→ or tab move between the answers, enter picks one, esc continues without.
 */
import { type Component, type Focusable, getKeybindings, visibleWidth } from "@veyraco/fingers-tui";
import { EE_FEATURES, OPEN_CORE_URL, tierName } from "../../../core/edition/features.ts";
import type { EeEntitlement, EeFeatureId, EeFeatureState } from "../../../core/edition/types.ts";
import { theme } from "../theme/theme.ts";
import { renderShellBox } from "./shell-box.ts";

export type EeLockedAnswer = "sign_in" | "continue";

export interface EeLockedBoxOptions {
	feature: EeFeatureId;
	state: Exclude<EeFeatureState, { on: true }>;
	entitlement: EeEntitlement;
	onAnswer: (answer: EeLockedAnswer) => void;
}

const MAX_BOX_WIDTH = 96;

/** What still works without the feature (canvas: "the MIT core runs this task as one agent"). */
const KEEP_WORKING: Partial<Record<EeFeatureId, string>> = {
	subagents: "You can keep working: the MIT core runs this task as one agent, on your local keys.",
};

/** The lines under the box (canvas FingersTuiLocked). */
export const LOCKED_FOOTNOTES = [
	"Also in ee: token saving (compaction, trimming, cheaper sub-task model), checkpoints, Brain, Eyes.",
	"Prompt caching that your provider does by itself stays on in the core.",
] as const;

/** The box title and the row that says why the feature is off. */
export function lockedReasonText(options: Pick<EeLockedBoxOptions, "feature" | "state" | "entitlement">): {
	title: string;
	why: string;
	canSignIn: boolean;
} {
	const { state, entitlement } = options;
	const info = EE_FEATURES[options.feature];
	const org = entitlement.orgName ?? entitlement.org ?? "your organization";
	const login = theme.fg("accent", "fingers login");
	const dim = (text: string) => theme.fg("dim", text);
	switch (state.reason) {
		case "signed_out":
			return {
				title: "ee feature · sign in to use it",
				why: `${dim(info.plural ? "They switch on after " : "It switches on after ")}${login}${dim(" when your organization’s Veyra tier includes them.")}`,
				canSignIn: true,
			};
		case "tier":
			return {
				title: "ee feature · not in your tier",
				why: dim(
					state.needs
						? `${info.plural ? "They need" : "It needs"} the ${tierName(state.needs)} tier or higher; ${org} is on ${tierName(entitlement.tier)}. Owners change the tier in Veyra Connect.`
						: `No Veyra tier includes ${info.listName} yet.`,
				),
				canSignIn: false,
			};
		case "fingers_off":
			return {
				title: "ee feature · Fingers is off for your organization",
				why: dim(`An admin of ${org} turns the Fingers app on in Veyra Connect.`),
				canSignIn: false,
			};
		case "offline":
			return {
				title: "ee feature · tier not confirmed",
				why: dim(
					"Fingers has not reached Veyra Connect for over 72 hours, so ee features stay off until it does. /org checks again.",
				),
				canSignIn: false,
			};
		case "denied":
			return {
				title: "ee feature · Connect did not confirm your organization",
				why: dim(
					`Veyra Connect refused the lookup of ${org}${entitlement.denied ? ` (${entitlement.denied})` : ""}. Sign in again or ask an admin.`,
				),
				canSignIn: true,
			};
		case "unknown_tier":
			return {
				title: "ee feature · unknown tier",
				why: dim(
					`Veyra Connect reports the tier “${entitlement.tier ?? ""}”, which this Fingers version does not know. Update Fingers.`,
				),
				canSignIn: false,
			};
		case "no_ee":
			return {
				title: "ee feature · not in this build",
				why: dim("This Fingers build has no ee/ module, so it runs as the MIT core only."),
				canSignIn: false,
			};
	}
}

export class EeLockedBoxComponent implements Component, Focusable {
	focused = false;
	private readonly options: EeLockedBoxOptions;
	private readonly answers: EeLockedAnswer[];
	private choice = 0;
	private answered = false;

	constructor(options: EeLockedBoxOptions) {
		this.options = options;
		this.answers = lockedReasonText(options).canSignIn ? ["sign_in", "continue"] : ["continue"];
	}

	get selectedAnswer(): EeLockedAnswer {
		return this.answers[this.choice]!;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { title, why } = lockedReasonText(this.options);
		const info = EE_FEATURES[this.options.feature];
		const boxWidth = Math.min(width, MAX_BOX_WIDTH);
		const labels: Record<EeLockedAnswer, string> = { sign_in: "Sign in now", continue: "Continue without" };
		const answers = this.answers
			.map((answer, index) =>
				index === this.choice
					? theme.bold(theme.fg("accent", `❯ ${labels[answer]}`))
					: theme.fg("text", labels[answer]),
			)
			.join("    ");
		const more = `${theme.fg("text", "What is in ee?  ")}${theme.fg("text", OPEN_CORE_URL)}`;
		const inner = boxWidth - 4;
		const answerRows = visibleWidth(`${answers}    ${more}`) <= inner ? [`${answers}    ${more}`] : [answers, more];
		const rows = [
			`${theme.bold(theme.fg("text", info.title))}${theme.fg("text", ` ${info.plural ? "are" : "is"} part of Fingers ee, under the Veyra commercial license.`)}`,
			why,
			"",
			theme.fg(
				"dim",
				KEEP_WORKING[this.options.feature] ?? "You can keep working with the MIT core, on your local keys.",
			),
			"",
			...answerRows,
		];
		return [
			...renderShellBox(title, rows, boxWidth, (text) => theme.fg("warning", text)),
			"",
			...LOCKED_FOOTNOTES.map((line) => theme.fg("muted", line)),
		];
	}

	handleInput(data: string): void {
		if (this.answered) return;
		const kb = getKeybindings();
		const count = this.answers.length;
		if (kb.matches(data, "tui.editor.cursorLeft") || kb.matches(data, "tui.select.up")) {
			this.choice = (this.choice + count - 1) % count;
		} else if (kb.matches(data, "tui.editor.cursorRight") || kb.matches(data, "tui.select.down") || data === "\t") {
			this.choice = (this.choice + 1) % count;
		} else if (kb.matches(data, "tui.select.confirm") || data === "\n") {
			this.finish(this.selectedAnswer);
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.finish("continue");
		}
	}

	private finish(answer: EeLockedAnswer): void {
		this.answered = true;
		this.options.onAnswer(answer);
	}
}
