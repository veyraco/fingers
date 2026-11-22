/**
 * `/login` in the terminal app: the device-code dialog drawn after the canvas artboard FingersTuiLogin, its keys
 * (c copy code, o open the link again, esc cancel), and the slash menu entries for the Veyra account.
 */
import { setKeybindings } from "@veyraco/fingers-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import {
	formatSignedInLine,
	VeyraLoginDialogComponent,
} from "../src/modes/interactive/components/veyra-login-dialog.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => {
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager());
});

const PROMPT = {
	userCode: "WDJB-MJHT",
	verificationUri: "https://connect.veyra.so/device",
	verificationUriComplete: "https://connect.veyra.so/device?user_code=WDJB-MJHT",
	expiresAt: 1_000_000 + 581_000,
	expiresInSeconds: 581,
};

function dialog() {
	const opened: string[] = [];
	const copied: string[] = [];
	let cancelled = 0;
	let renders = 0;
	const component = new VeyraLoginDialogComponent({
		requestRender: () => {
			renders++;
		},
		onCancel: () => {
			cancelled++;
		},
		openUrl: (url) => opened.push(url),
		copy: async (text) => {
			copied.push(text);
		},
		now: () => 1_000_000,
	});
	return {
		component,
		opened,
		copied,
		cancelled: () => cancelled,
		renders: () => renders,
		lines: () => component.render(120).map((line) => stripAnsi(line).trimEnd()),
	};
}

describe("the /login dialog", () => {
	it("asks Connect for a code first", () => {
		const d = dialog();
		expect(d.lines().join("\n")).toContain("Asking Veyra Connect for a sign-in code");
		d.component.dispose();
	});

	it("shows the code screen of the canvas with the countdown", () => {
		const d = dialog();
		d.component.showCode(PROMPT, { browserOpened: true });
		const lines = d.lines().filter((line) => line.trim() !== "" && !/^─+$/.test(line.trim()));
		expect(lines).toEqual([
			"Sign in to Veyra Connect to use your organization’s model connections and ee features.",
			"  1. Your browser opened https://connect.veyra.so/device",
			"  2. Check that it shows this code, then confirm:",
			"     WDJB-MJHT",
			"◐ Waiting for you to confirm in the browser   code expires in 9:41",
			"  c copy code · o open the link again · esc cancel",
		]);
		d.component.dispose();
	});

	it("c copies the code, o opens the link again, esc cancels and aborts the sign-in", () => {
		const d = dialog();
		d.component.showCode(PROMPT, { browserOpened: false });
		expect(d.lines()).toContain("  1. Open https://connect.veyra.so/device in a browser");
		d.component.handleInput("c");
		d.component.handleInput("o");
		expect(d.copied).toEqual(["WDJB-MJHT"]);
		expect(d.opened).toEqual(["https://connect.veyra.so/device?user_code=WDJB-MJHT"]);
		expect(d.component.signal.aborted).toBe(false);
		d.component.handleInput("\x1b");
		expect(d.component.signal.aborted).toBe(true);
		expect(d.cancelled()).toBe(1);
		d.component.dispose();
	});

	it("formats the signed-in line as on the artboard", () => {
		expect(stripAnsi(formatSignedInLine({ email: "ada@acme.dev", orgName: "Acme Robotics", tier: "medium" }))).toBe(
			"✓ Signed in as ada@acme.dev  ·  org Acme Robotics  ·  tier medium",
		);
		expect(stripAnsi(formatSignedInLine({ email: "ada@acme.dev" }))).toBe("✓ Signed in as ada@acme.dev");
	});
});

describe("slash commands for the Veyra account", () => {
	it("/login signs in to Veyra Connect, /org shows the organization, /logout signs out", () => {
		const byName = new Map(BUILTIN_SLASH_COMMANDS.map((command) => [command.name, command]));
		expect(byName.get("login")?.description).toBe("sign in to Veyra Connect (device code)");
		expect(byName.get("login")?.argumentHint).toBe("[provider]");
		expect(byName.get("org")?.description).toBe("Veyra organization, tier and group · switch by signing in again");
		expect(byName.get("logout")?.description).toBe("sign out of Veyra (revokes the device) · /logout <provider>");
	});
});
