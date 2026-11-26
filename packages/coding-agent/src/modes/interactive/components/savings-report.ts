/**
 * The token-saving report in the chat (canvas FingersTuiSavings), from core/savings-report.ts. Rebuilt on every
 * render, so it follows theme changes and the terminal width (the rule shortens, long lines are cut).
 */
import { type Component, truncateToWidth } from "@veyraco/fingers-tui";
import { type ReportTone, type SavingsReport, savingsReportLines } from "../../../core/savings-report.ts";
import { theme } from "../theme/theme.ts";

function paint(text: string, tone: ReportTone, bold: boolean | undefined): string {
	const colored = theme.fg(tone, text);
	return bold ? theme.bold(colored) : colored;
}

export class SavingsReportComponent implements Component {
	private readonly report: SavingsReport;

	constructor(report: SavingsReport) {
		this.report = report;
	}

	render(width: number): readonly string[] {
		const inner = Math.max(20, width - 1);
		return savingsReportLines(this.report, inner).map((line) =>
			truncateToWidth(
				` ${line.map((segment) => paint(segment.text, segment.tone, segment.bold)).join("")}`,
				width,
				"…",
			),
		);
	}

	invalidate(): void {}
}
