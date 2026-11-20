/**
 * Titlebar Spinner Extension
 *
 * Shows a braille spinner animation in the terminal title while the agent is working.
 * Uses `ctx.ui.setTitle()` to update the terminal title via the extension API.
 *
 * Usage:
 *   fingers --extension examples/extensions/titlebar-spinner.ts
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@veyraco/fingers";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getBaseTitle(fingers: ExtensionAPI): string {
	const cwd = path.basename(process.cwd());
	const session = fingers.getSessionName();
	return session ? `fingers - ${session} - ${cwd}` : `fingers - ${cwd}`;
}

export default function (fingers: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;

	function stopAnimation(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
		ctx.ui.setTitle(getBaseTitle(fingers));
	}

	function startAnimation(ctx: ExtensionContext) {
		stopAnimation(ctx);
		timer = setInterval(() => {
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
			const cwd = path.basename(process.cwd());
			const session = fingers.getSessionName();
			const title = session ? `${frame} fingers - ${session} - ${cwd}` : `${frame} fingers - ${cwd}`;
			ctx.ui.setTitle(title);
			frameIndex++;
		}, 80);
	}

	fingers.on("agent_start", async (_event, ctx) => {
		startAnimation(ctx);
	});

	fingers.on("agent_settled", async (_event, ctx) => {
		stopAnimation(ctx);
	});

	fingers.on("session_shutdown", async (_event, ctx) => {
		stopAnimation(ctx);
	});
}
