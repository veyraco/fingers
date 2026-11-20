/**
 * The terminal screens from the canvas ("Fingers · CLI & web": FingersTuiFirstRun, FingersTuiSession,
 * FingersTuiSlash), rendered into a 120x36 virtual terminal. Texts must match the artboards.
 */
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	type SlashCommand,
	setKeybindings,
	TuiMainScreen,
} from "@veyraco/fingers-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SLASH_MENU } from "../src/core/slash-commands.ts";
import { type ApprovalAnswer, ApprovalBoxComponent } from "../src/modes/interactive/components/approval-box.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { FINGERS_MARK_PIXELS, fingersBannerLines } from "../src/modes/interactive/components/fingers-logo.ts";
import {
	type FirstRunChoice,
	FirstRunChooserComponent,
	formatDetectedCredential,
} from "../src/modes/interactive/components/first-run-chooser.ts";
import { FooterComponent, formatCost, formatTokenCount } from "../src/modes/interactive/components/footer.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const COLUMNS = 120;
const ROWS = 36;

async function renderScreen(root: Component): Promise<string[]> {
	const terminal = new VirtualTerminal(COLUMNS, ROWS);
	const tui = new TuiMainScreen(terminal);
	tui.addChild(root);
	tui.start();
	tui.renderNow();
	const viewport = await terminal.flushAndGetViewport();
	tui.stop();
	return viewport.map((line) => line.trimEnd());
}

/** Every expected line appears, in order. A string must equal the trimmed line; a RegExp must match it. */
function expectInOrder(lines: string[], expected: Array<string | RegExp>): void {
	let from = 0;
	for (const want of expected) {
		const index = lines.findIndex(
			(line, i) => i >= from && (typeof want === "string" ? line.trim() === want : want.test(line)),
		);
		if (index === -1) {
			throw new Error(`missing ${String(want)} after line ${from} in:\n${lines.join("\n")}`);
		}
		from = index + 1;
	}
}

beforeAll(() => {
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager());
});

describe("the Fingers banner", () => {
	it("draws the mark in three lines next to Veyra Fingers and the version", () => {
		const lines = fingersBannerLines({ version: "0.1.0", showMark: true }).map(stripAnsi);
		expect(lines).toEqual(["  ▄▀▀ ▀  Veyra Fingers", " ▀█▀▀    v0.1.0 · coding agent harness", "  █"]);
		expect(FINGERS_MARK_PIXELS).toHaveLength(6);
	});

	it("falls back to the text lines where half blocks do not render", () => {
		const lines = fingersBannerLines({ version: "0.1.0", showMark: false, hints: "esc interrupt" }).map(stripAnsi);
		expect(lines).toEqual(["Veyra Fingers", "v0.1.0 · coding agent harness", "esc interrupt"]);
	});
});

describe("FingersTuiFirstRun", () => {
	const detected = [
		{ label: "Anthropic API", providerId: "anthropic", source: "ANTHROPIC_API_KEY" },
		{ label: "OpenAI", providerId: "openai", source: "OPENAI_API_KEY" },
		{ label: "Amazon Bedrock", providerId: "amazon-bedrock", source: '~/.aws profile "dev"' },
	];

	function chooser(onChoose: (choice: FirstRunChoice) => void = () => {}) {
		return new FirstRunChooserComponent({ version: "0.1.0", detected, onChoose, onCancel: () => {} });
	}

	it("matches the artboard at 120x36", async () => {
		const lines = await renderScreen(chooser());
		expect(lines.filter((line) => line.length > 0).length).toBeLessThanOrEqual(ROWS);
		expectInOrder(lines, [
			"▄▀▀ ▀  Veyra Fingers",
			"▀█▀▀    v0.1.0 · coding agent harness · first run",
			"Fingers needs a model to work with. How do you want to connect?",
			"❯ 1  Sign in to Veyra       fingers login · use your org’s model connections from Veyra Connect, ee features by tier",
			"2  Use an API key         stored in your OS keychain, never leaves this machine",
			"3  Use environment keys   read ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY …",
			"Provider for option 2",
			"● Anthropic API   ○ Amazon Bedrock   ○ Google Vertex AI   ○ OpenAI   ○ Google Gemini   ○ OpenRouter",
			"○ Moonshot Kimi   ○ xAI Grok         ○ DeepSeek           ○ Qwen     ○ Any OpenAI-compatible endpoint",
			'Found on this machine  ANTHROPIC_API_KEY ✓   OPENAI_API_KEY ✓   ~/.aws profile "dev" (Bedrock) ✓',
			/^ ╭─ Open core ─+╮$/,
			/^ │ The MIT core works without an account: chat, tools, edits, approvals, MCP, skills, hooks\. +│$/,
			/^ │ Token saving, sub-agents, checkpoints, Brain memory and Eyes telemetry live in ee\/ and switch +│$/,
			/^ │ on after fingers login when your organization’s Veyra tier includes them\. +│$/,
			/^ ╰─+╯$/,
			"↑↓ choose · enter confirm · ? help · esc quit",
		]);
	});

	it("chooses a provider for option 2 with the arrow keys", () => {
		const choices: FirstRunChoice[] = [];
		const component = chooser((choice) => choices.push(choice));
		component.handleInput("\x1b[C"); // right: option 2, Amazon Bedrock
		component.handleInput("\x1b[C"); // Google Vertex AI
		component.handleInput("\r");
		component.handleInput("3");
		component.handleInput("\r");
		component.handleInput("\x1b[A"); // up from 3 to 2
		component.handleInput("\x1b[A"); // 1
		component.handleInput("\r");
		expect(choices.map((choice) => choice.kind)).toEqual(["api_key", "env", "veyra"]);
		expect(choices[0]).toMatchObject({ kind: "api_key", provider: { label: "Google Vertex AI" } });
		expect(choices[1]).toMatchObject({ kind: "env", detected });
	});

	it("names what it found without printing values", () => {
		expect(formatDetectedCredential(detected[0]!)).toBe("ANTHROPIC_API_KEY");
		expect(formatDetectedCredential(detected[2]!)).toBe('~/.aws profile "dev" (Bedrock)');
	});

	it("shows a notice under the options", async () => {
		const component = chooser();
		component.setNotice(["Signing in to Veyra needs `fingers login`."]);
		expectInOrder(await renderScreen(component), [
			"3  Use environment keys   read ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY …",
			"Signing in to Veyra needs `fingers login`.",
			"Provider for option 2",
		]);
	});
});

function fakeSession(): AgentSession {
	const entries = [
		{
			type: "message",
			message: {
				role: "assistant",
				usage: { input: 3_312, output: 2_100, cacheRead: 15_088, cacheWrite: 0, cost: { total: 0.06 } },
			},
		},
	];
	return {
		state: {
			model: { id: "claude-opus-5-5", provider: "anthropic", contextWindow: 200_000, reasoning: false },
			thinkingLevel: "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getEntryCount: () => entries.length,
			getSessionId: () => "s1",
			getLeafId: () => "l1",
			getSessionName: () => undefined,
			getCwd: () => "/home/dev/acme/web",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 9.2, tokens: 18_400 }),
		routedModel: undefined,
		modelRuntime: { isUsingSubscription: () => false },
	} as unknown as AgentSession;
}

const footerData: ReadonlyFooterDataProvider = {
	getGitBranch: () => "main",
	getExtensionStatuses: () => new Map(),
	getAvailableProviderCount: () => 1,
	onBranchChange: () => () => {},
};

describe("FingersTuiSession", () => {
	const home = process.env.HOME;
	beforeEach(() => {
		process.env.HOME = "/home/dev";
	});
	afterEach(() => {
		process.env.HOME = home;
	});

	function approvalBox(onAnswer: (answer: ApprovalAnswer) => void = () => {}) {
		return new ApprovalBoxComponent({
			action: "run a command",
			summary: "pnpm vitest run src/server/routes/auth.test.ts",
			isCommand: true,
			reason: "Not in your allow list.",
			allowPattern: "pnpm vitest",
			onAnswer,
		});
	}

	const signedIn = {
		getAccount: () => ({ signedIn: true, eeOn: true, email: "atakan@veyra.so", org: "Veyra App Factory" }),
		getBudget: () => ({ spentUsd: 0.06, capUsd: 5 }),
		getMemory: () => "Brain “acme-web”",
	};

	it("matches the artboard's approval box and status line at 120x36", async () => {
		const footer = new FooterComponent(fakeSession(), footerData, signedIn);
		const root = new Container();
		root.addChild(approvalBox());
		root.addChild(footer);
		const lines = await renderScreen(root);
		expectInOrder(lines, [
			/^╭─ Approval needed · run a command ─+╮$/,
			/^│ \$ pnpm vitest run src\/server\/routes\/auth\.test\.ts +│$/,
			/^│ Not in your allow list\. +│$/,
			/^│ +│$/,
			/^│ ❯ Yes {4}Yes, always allow “pnpm vitest” {4}No, tell Fingers what to do instead +│$/,
			/^╰─+╯$/,
			"enter send · shift+enter newline · / commands · @ files · esc interrupt",
			"~/acme/web  ·  main  ·  org Veyra App Factory  ·  memory: Brain “acme-web”",
			// The artboard's status line is 122 cells with its placeholder model; at 120 the provider name goes first.
			"claude-opus-5-5 │ 18.4k in · 2.1k out │ $0.06 │ cache 82% │ budget $4.94 left of $5.00 │ ee on · atakan@veyra.so",
		]);
	});

	it("shows the artboard's full status line when the terminal is wide enough", () => {
		const lines = new FooterComponent(fakeSession(), footerData, signedIn).render(130).map(stripAnsi);
		expect(lines[2]?.trim()).toBe(
			"claude-opus-5-5  anthropic │ 18.4k in · 2.1k out │ $0.06 │ cache 82% │ budget $4.94 left of $5.00 │ ee on · atakan@veyra.so",
		);
		expect(lines[2]).toHaveLength(130);
	});

	it("shows core only while not signed in", async () => {
		const lines = await renderScreen(new FooterComponent(fakeSession(), footerData));
		const status = lines.find((line) => line.includes("18.4k in"));
		expect(status?.trim()).toBe(
			"claude-opus-5-5  anthropic │ 18.4k in · 2.1k out │ $0.06 │ cache 82% │ core only · not signed in",
		);
	});

	it("answers Yes, always allow, and No with what to do instead", () => {
		const answers: ApprovalAnswer[] = [];
		approvalBox((answer) => answers.push(answer)).handleInput("\r");
		const always = approvalBox((answer) => answers.push(answer));
		always.handleInput("\x1b[C");
		always.handleInput("\r");
		const tell = approvalBox((answer) => answers.push(answer));
		tell.handleInput("\x1b[C");
		tell.handleInput("\x1b[C");
		tell.handleInput("\r");
		expect(tell.isTellingFingers).toBe(true);
		for (const char of "use the helper") tell.handleInput(char);
		tell.handleInput("\r");
		approvalBox((answer) => answers.push(answer)).handleInput("\x1b");
		expect(answers).toEqual([
			{ decision: "allow_once" },
			{ decision: "allow_always" },
			{ decision: "deny", message: "use the helper" },
			{ decision: "deny" },
		]);
	});

	it("says no model instead of the session's unknown placeholder", () => {
		const session = fakeSession();
		(session.state as { model: unknown }).model = { id: "unknown", provider: "unknown", contextWindow: 0 };
		const status = stripAnsi(new FooterComponent(session, footerData).render(120)[2] ?? "");
		expect(status.trim().startsWith("no model │ 18.4k in")).toBe(true);
	});

	it("keeps the status line within narrow terminals", async () => {
		const footer = new FooterComponent(fakeSession(), footerData);
		for (const line of footer.render(50)) expect(stripAnsi(line).length).toBeLessThanOrEqual(50);
	});
});

describe("status line formats", () => {
	it("formats tokens and dollars as the canvas does", () => {
		expect([950, 2_100, 18_400, 412_000, 1_210_000].map(formatTokenCount)).toEqual([
			"950",
			"2.1k",
			"18.4k",
			"412.0k",
			"1.21M",
		]);
		expect([0, 0.004, 0.06, 4.94].map(formatCost)).toEqual(["$0.00", "$0.004", "$0.06", "$4.94"]);
	});
});

describe("FingersTuiSlash", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const commands: SlashCommand[] = [
		{ name: "model", description: "switch model or provider · now [MODEL NAME] on anthropic" },
		{ name: "memory", description: "Brain memory: what Fingers remembers about this repo" },
		{ name: "agents", description: "sub-agents: start, watch, steer, stop", tag: "ee" },
		{ name: "budget", description: "set or view the task budget · $4.94 of $5.00 left" },
		{ name: "compact", description: "summarise older turns now · saves ~31k tokens", tag: "ee" },
		{ name: "hooks", description: "pre/post tool hooks · 3 active (1 from org policy)" },
		{ name: "mcp", description: "MCP servers · github, linear, postgres · 41 tools" },
		{ name: "skills", description: "skills in this repo and from Veyra · 7 enabled" },
		{ name: "login", description: "sign in to Veyra Connect (device code)" },
	];

	it("matches the artboard's command box with ee tags at 120x36", async () => {
		const keybindings = new KeybindingsManager();
		const tui = new TuiMainScreen(new VirtualTerminal(COLUMNS, ROWS));
		const editor = new CustomEditor(tui, getEditorTheme(), keybindings, {
			autocompleteMaxVisible: 10,
			slashMenu: SLASH_MENU,
		});
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, process.cwd()));
		editor.handleInput("/");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		const lines = await renderScreen(editor);
		expectInOrder(lines, [
			/^╭─ Commands ─+╮$/,
			/^│ ❯ \/model +switch model or provider · now \[MODEL NAME\] on anthropic +│$/,
			/^│ {3}\/memory +Brain memory: what Fingers remembers about this repo +│$/,
			/^│ {3}\/agents +sub-agents: start, watch, steer, stop {3}ee +│$/,
			/^│ {3}\/budget +set or view the task budget · \$4\.94 of \$5\.00 left +│$/,
			/^│ {3}\/compact +summarise older turns now · saves ~31k tokens {3}ee +│$/,
			/^│ {3}\/hooks +pre\/post tool hooks · 3 active \(1 from org policy\) +│$/,
			/^│ {3}\/mcp +MCP servers · github, linear, postgres · 41 tools +│$/,
			/^│ {3}\/skills +skills in this repo and from Veyra · 7 enabled +│$/,
			/^│ {3}\/login +sign in to Veyra Connect \(device code\) +│$/,
			/^│ +│$/,
			/^│ ee = needs fingers login and a Veyra tier that includes it +│$/,
			/^╰─+╯$/,
			"↑↓ move · tab complete · enter run · esc close",
		]);
	});
});
