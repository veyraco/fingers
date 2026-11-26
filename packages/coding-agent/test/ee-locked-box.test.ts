/**
 * Open core in the terminal app: /agents is an ee command (tagged `ee` in the slash menu). Signed out, or while the
 * organization's tier does not include sub-agents, it shows the locked box of the canvas artboard FingersTuiLocked
 * instead of running; signed in with a tier that includes it, the ee module's handler runs. The status line says
 * "ee on" or "core only". A stand-in ee module is used, so these tests pass without the ee/ folder.
 */
import { tmpdir } from "node:os";
import { setKeybindings } from "@veyraco/fingers-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	coreOnlyText,
	EditionGate,
	type EeEntitlement,
	type EeFeatureId,
	type EeModule,
	parseEeCommand,
	SIGNED_OUT,
	type VeyraTier,
} from "../src/core/edition/index.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { EeLockedBoxComponent, LOCKED_FOOTNOTES } from "../src/modes/interactive/components/ee-locked-box.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => {
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager());
});

const MATRIX: Record<EeFeatureId, VeyraTier> = {
	token_saving: "low",
	subagents: "medium",
	checkpoints: "medium",
	brain: "medium",
	eyes: "medium",
	org_hooks: "high",
};

function eeModule(): EeModule {
	return {
		apiVersion: 7,
		matrixVersion: "test.1",
		minimumTier: (feature) => MATRIX[feature],
		activate: (host) => {
			if (host.isOn("subagents")) {
				host.registerCommand("agents", (context) => context.showStatus(`agents ran with "${context.args}"`));
			}
		},
	};
}

const MEDIUM: EeEntitlement = {
	signedIn: true,
	source: "connect",
	org: "org_1",
	orgName: "Acme Robotics",
	tier: "medium",
	fingersEnabled: true,
	checkedAt: Date.now(),
};

const ESC = "\u001b";
const ENTER = "\r";

function lines(component: { render(width: number): string[] }, width = 120): string[] {
	return component.render(width).map((line) => stripAnsi(line).trimEnd());
}

describe("FingersTuiLocked: the locked box", () => {
	it("matches the artboard signed out: title, feature, sign-in, the core keeps working, answers, footnotes", () => {
		const box = new EeLockedBoxComponent({
			feature: "subagents",
			state: { on: false, reason: "signed_out" },
			entitlement: SIGNED_OUT,
			onAnswer: () => {},
		});
		const text = lines(box);
		expect(text[0]).toMatch(/^╭─ ee feature · sign in to use it ─+╮$/);
		expect(text.slice(1, 7).map((line) => line.replace(/^│ /, "").replace(/\s*│$/, ""))).toEqual([
			"Sub-agents are part of Fingers ee, under the Veyra commercial license.",
			"They switch on after fingers login when your organization’s Veyra tier includes them.",
			"",
			"You can keep working: the MIT core runs this task as one agent, on your local keys.",
			"",
			"❯ Sign in now    Continue without    What is in ee?  veyra.so/fingers/open-core",
		]);
		expect(text[7]).toMatch(/^╰─+╯$/);
		expect(text.slice(8)).toEqual(["", ...LOCKED_FOOTNOTES]);
		for (const line of text.slice(0, 8)) expect(line.length).toBeLessThanOrEqual(96);
	});

	it("moves between the answers and answers esc with continue without", () => {
		const answers: string[] = [];
		const box = new EeLockedBoxComponent({
			feature: "subagents",
			state: { on: false, reason: "signed_out" },
			entitlement: SIGNED_OUT,
			onAnswer: (answer) => answers.push(answer),
		});
		expect(box.selectedAnswer).toBe("sign_in");
		box.handleInput("\t");
		expect(box.selectedAnswer).toBe("continue");
		expect(lines(box).join("\n")).toContain("Sign in now    ❯ Continue without");
		box.handleInput("\t");
		box.handleInput(ENTER);
		expect(answers).toEqual(["sign_in"]);
		box.handleInput(ESC);
		expect(answers).toEqual(["sign_in"]);

		const other = new EeLockedBoxComponent({
			feature: "subagents",
			state: { on: false, reason: "signed_out" },
			entitlement: SIGNED_OUT,
			onAnswer: (answer) => answers.push(answer),
		});
		other.handleInput(ESC);
		expect(answers).toEqual(["sign_in", "continue"]);
	});

	it("says which tier is needed and offers no sign-in when the tier is too low", () => {
		const box = new EeLockedBoxComponent({
			feature: "subagents",
			state: { on: false, reason: "tier", needs: "medium" },
			entitlement: { ...MEDIUM, tier: "low" },
			onAnswer: () => {},
		});
		const text = lines(box).join("\n");
		expect(text).toContain("ee feature · not in your tier");
		expect(text).toContain("They need the Medium tier or higher; Acme Robotics is on Low.");
		expect(text).toContain("❯ Continue without");
		expect(text).not.toContain("Sign in now");
	});

	it("names the other reasons", () => {
		const cases: Array<[EeEntitlement, Parameters<typeof coreOnlyText>[0], string]> = [
			[
				{ ...MEDIUM, fingersEnabled: false },
				{ on: false, reason: "fingers_off" },
				"Fingers is off for your organization",
			],
			[{ ...MEDIUM, source: "none", offline: true }, { on: false, reason: "offline" }, "tier not confirmed"],
			[{ ...MEDIUM, tier: "gold" }, { on: false, reason: "unknown_tier" }, "unknown tier"],
			[MEDIUM, { on: false, reason: "no_ee" }, "not in this build"],
			[{ ...MEDIUM, denied: "403 permission_denied" }, { on: false, reason: "denied" }, "did not confirm"],
		];
		for (const [entitlement, state, title] of cases) {
			if (state.on) continue;
			const box = new EeLockedBoxComponent({ feature: "subagents", state, entitlement, onAnswer: () => {} });
			expect(lines(box)[0]).toContain(title);
			expect(coreOnlyText(state, entitlement).length).toBeGreaterThan(5);
		}
	});
});

describe("/agents in the terminal app", () => {
	it("is a built-in command tagged ee in the slash menu", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "agents")).toEqual({
			name: "agents",
			description: "sub-agents: start, watch, steer, stop",
			edition: "ee",
		});
	});

	/** An InteractiveMode with only what the ee command path uses. */
	function mode(entitlement: EeEntitlement) {
		const gate = new EditionGate({ loadModule: async () => eeModule() });
		const children: unknown[] = [];
		const editor = { name: "editor" };
		const instance = Object.create(InteractiveMode.prototype) as Record<string, any>;
		Object.assign(instance, {
			editionGate: gate,
			editor,
			editorContainer: {
				clear: () => children.splice(0),
				addChild: (child: unknown) => children.push(child),
			},
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
			handleVeyraLogin: vi.fn(async () => true),
			// ee commands get the session's directory and its repository (F20).
			runtimeHost: { session: { sessionManager: { getCwd: () => tmpdir() } } },
		});
		return {
			instance,
			gate,
			children,
			editor,
			ready: () => gate.setEntitlement(entitlement),
			run: (text: string) => {
				const command = parseEeCommand(text);
				if (!command) throw new Error(`${text} is not an ee command`);
				return instance.handleEeCommand(command.name, command.args) as Promise<void>;
			},
		};
	}

	async function untilBox(children: unknown[]): Promise<EeLockedBoxComponent> {
		await vi.waitFor(() => expect(children[0]).toBeInstanceOf(EeLockedBoxComponent));
		return children[0] as EeLockedBoxComponent;
	}

	it("shows the locked box in place of the editor when signed out, and esc brings the editor back", async () => {
		const m = mode(SIGNED_OUT);
		await m.ready();
		const done = m.run("/agents");
		const box = await untilBox(m.children);
		expect(lines(box)[0]).toContain("ee feature · sign in to use it");
		expect(m.instance.ui.setFocus).toHaveBeenCalledWith(box);
		box.handleInput(ESC);
		await done;
		expect(m.children).toEqual([m.editor]);
		expect(m.instance.handleVeyraLogin).not.toHaveBeenCalled();
		expect(m.instance.showStatus).not.toHaveBeenCalled();
	});

	it("runs the Veyra sign-in from Sign in now", async () => {
		const m = mode(SIGNED_OUT);
		await m.ready();
		const done = m.run("/agents");
		(await untilBox(m.children)).handleInput(ENTER);
		await done;
		expect(m.instance.handleVeyraLogin).toHaveBeenCalledTimes(1);
	});

	it("shows the locked box when the tier does not include sub-agents", async () => {
		const m = mode({ ...MEDIUM, tier: "low" });
		await m.ready();
		const done = m.run("/agents");
		const box = await untilBox(m.children);
		expect(lines(box)[0]).toContain("not in your tier");
		box.handleInput(ESC);
		await done;
	});

	it("runs the ee module's handler, with the arguments, when the tier includes sub-agents", async () => {
		const m = mode(MEDIUM);
		await m.ready();
		await m.run("/agents watch  ");
		expect(m.instance.showStatus).toHaveBeenCalledWith('agents ran with "watch"');
		expect(m.children).toEqual([]);
	});

	it("only treats ee command names as ee commands", () => {
		expect(parseEeCommand("/agents")).toEqual({ name: "agents", args: "" });
		expect(parseEeCommand("/agents  watch 2 ")).toEqual({ name: "agents", args: "watch 2" });
		expect(parseEeCommand("/agentsx")).toBeUndefined();
		expect(parseEeCommand("/model")).toBeUndefined();
		expect(parseEeCommand("/constructor")).toBeUndefined();
		expect(parseEeCommand("agents")).toBeUndefined();
	});

	it("says ee on in the status line only while an ee feature is on", async () => {
		const m = mode(MEDIUM);
		m.instance.veyraAccount = { subject: "usr_ada", email: "ada@example.com", orgName: "Acme Robotics" };
		await m.ready();
		expect(m.instance.getVeyraAccountStatus()).toEqual({
			signedIn: true,
			email: "ada@example.com",
			org: "Acme Robotics",
			eeOn: true,
		});
		await m.gate.setEntitlement({ ...MEDIUM, tier: "free" });
		expect(m.instance.getVeyraAccountStatus().eeOn).toBe(false);
	});
});
