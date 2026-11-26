/**
 * The Veyra account commands in the terminal app: how /login, /logout and /org are routed (canvas FingersTuiSlash:
 * /login alone is the Veyra sign-in, /login <provider> configures a provider), what /org and /logout show, and that
 * strings from Connect reach the screen without terminal escapes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { editionToolHooks, savingsLedger } from "../src/core/edition/tool-hooks.ts";
import { veyraModelConnections } from "../src/core/veyra/connection-provider.ts";
import { DeviceFlowError } from "../src/core/veyra/device-flow.ts";
import type { ModelConnectionsList } from "../src/core/veyra/model-connections.ts";
import { type VeyraAccount, VeyraSessionClearedError } from "../src/core/veyra/session-vault.ts";
import { type VeyraLogoutResult, type VeyraOrganization, VeyraSignedOutError } from "../src/core/veyra/veyra-auth.ts";
import type { FingersAccountStatus } from "../src/modes/interactive/components/footer.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type Mock = ReturnType<typeof vi.fn>;

interface SubmitContext {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> | void };
	editor: { setText: Mock; addToHistory: Mock };
	session: { isCompacting: boolean; isStreaming: boolean; isBashRunning: boolean; prompt: Mock };
	flushPendingBashComponents: Mock;
	pendingUserInputs: string[];
	veyraAccount?: VeyraAccount;
	handleLoginCommand: Mock;
	handleVeyraLogin: Mock;
	handleVeyraLogout: Mock;
	showOAuthSelector: Mock;
	handleOrgCommand: Mock;
	showWarning: Mock;
}

interface FakeAuth {
	issuer: string;
	account: Mock;
	organization: Mock;
	logout: Mock;
	login: Mock;
}

interface AccountContext {
	veyraAccount?: VeyraAccount;
	veyraSignInRunning?: boolean;
	getVeyraAuth: () => FakeAuth | undefined;
	handleVeyraLogin: Mock;
	showStatus: Mock;
	showWarning: Mock;
	showError: Mock;
	ui: { requestRender: Mock; setFocus: Mock };
	editor: object;
	editorContainer: { clear: Mock; addChild: Mock };
	programStatus: { setBlocked: Mock };
	/** The ee gate (F12): /org names the ee features that are on, /logout turns them off. */
	editionGate: FakeEditionGate;
	getEditionGate(this: AccountContext): FakeEditionGate;
	startEdition: Mock;
	editionTimer?: ReturnType<typeof setInterval>;
	/** F13: the organization's model connections. */
	loadModelConnections: Mock;
	updateAvailableProviderCount: Mock;
	chatContainer: { addChild: Mock };
	modelConnectionsProblem?: string;
}

interface FakeEditionGate {
	isOn: Mock;
	onFeatures: Mock;
	setEntitlement: Mock;
}

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	handleOrgCommand(this: AccountContext, argument: string): Promise<void>;
	handleVeyraLogout(this: AccountContext): Promise<void>;
	handleVeyraLogin(this: AccountContext): Promise<boolean>;
	getVeyraAccountStatus(this: { veyraAccount?: VeyraAccount }): FingersAccountStatus | undefined;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

const OSC52 = "\u001b]52;c;cm0gLXJmIH4K\u0007";
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const ACCOUNT: VeyraAccount = {
	issuer: "https://connect.veyra.so",
	subject: "usr_ada",
	email: "ada@example.com",
	org: "org_7aR2cT",
	orgName: "Acme Robotics",
	signedInAt: 0,
	storage: { persistent: true, location: "macOS Keychain" },
};

const ORG: VeyraOrganization = {
	id: "org_7aR2cT",
	code: "acme",
	name: "Acme Robotics",
	tier: "medium",
	appsEnabled: ["connect", "fingers"],
	groupName: "Editor",
};

function submitContext(options: { signedIn?: boolean } = {}): SubmitContext {
	return {
		defaultEditor: {},
		editor: { setText: vi.fn(), addToHistory: vi.fn() },
		session: { isCompacting: false, isStreaming: false, isBashRunning: false, prompt: vi.fn(async () => {}) },
		flushPendingBashComponents: vi.fn(),
		pendingUserInputs: [],
		veyraAccount: options.signedIn ? ACCOUNT : undefined,
		handleLoginCommand: vi.fn(async () => {}),
		handleVeyraLogin: vi.fn(async () => true),
		handleVeyraLogout: vi.fn(async () => {}),
		showOAuthSelector: vi.fn(async () => {}),
		handleOrgCommand: vi.fn(async () => {}),
		showWarning: vi.fn(),
	};
}

async function submit(context: SubmitContext, text: string): Promise<void> {
	prototype.setupEditorSubmitHandler.call(context);
	await context.defaultEditor.onSubmit?.(text);
}

function fakeAuth(overrides: Partial<FakeAuth> = {}): FakeAuth {
	return {
		issuer: "https://connect.veyra.so",
		account: vi.fn(() => ACCOUNT),
		organization: vi.fn(async () => ORG),
		logout: vi.fn(async (): Promise<VeyraLogoutResult> => ({ signedIn: true, revocation: "revoked" })),
		login: vi.fn(async () => ACCOUNT),
		...overrides,
	};
}

function accountContext(auth: FakeAuth | undefined, options: { signedIn?: boolean } = {}): AccountContext {
	return {
		veyraAccount: options.signedIn === false ? undefined : ACCOUNT,
		getVeyraAuth: () => auth,
		handleVeyraLogin: vi.fn(async () => true),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		ui: { requestRender: vi.fn(), setFocus: vi.fn() },
		editor: {},
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		programStatus: { setBlocked: vi.fn() },
		editionGate: {
			isOn: vi.fn(() => true),
			onFeatures: vi.fn(() => ["token_saving"]),
			setEntitlement: vi.fn(async () => {}),
		},
		getEditionGate() {
			return this.editionGate;
		},
		startEdition: vi.fn(async () => {}),
		loadModelConnections: vi.fn(async () => undefined),
		updateAvailableProviderCount: vi.fn(async () => {}),
		chatContainer: { addChild: vi.fn() },
	};
}

/** The text of every line the context added to the chat, without styling. */
function chatLines(context: AccountContext): string[] {
	return context.chatContainer.addChild.mock.calls
		.map(([component]) => (component as { text?: string }).text)
		.filter((text): text is string => typeof text === "string")
		.map((text) => text.replace(/\u001b\[[0-9;]*m/g, ""));
}

/** Every message the context showed, of any kind. */
function shown(context: AccountContext): string[] {
	return [...context.showStatus.mock.calls, ...context.showWarning.mock.calls, ...context.showError.mock.calls].map(
		([message]) => String(message),
	);
}

describe("routing of /login, /logout and /org", () => {
	it("/login without a provider is the Veyra sign-in", async () => {
		const context = submitContext();
		await submit(context, "/login");
		expect(context.handleVeyraLogin).toHaveBeenCalledTimes(1);
		expect(context.handleLoginCommand).not.toHaveBeenCalled();
		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.session.prompt).not.toHaveBeenCalled();
	});

	it("/login <provider> configures that provider, as before", async () => {
		const context = submitContext();
		await submit(context, "/login anthropic");
		expect(context.handleLoginCommand).toHaveBeenCalledWith("anthropic");
		expect(context.handleVeyraLogin).not.toHaveBeenCalled();
	});

	it("/logout signs out of Veyra when signed in", async () => {
		const context = submitContext({ signedIn: true });
		await submit(context, "/logout");
		expect(context.handleVeyraLogout).toHaveBeenCalledTimes(1);
		expect(context.showOAuthSelector).not.toHaveBeenCalled();
	});

	it("/logout without a Veyra sign-in falls back to the provider selector", async () => {
		const context = submitContext({ signedIn: false });
		await submit(context, "/logout");
		expect(context.showOAuthSelector).toHaveBeenCalledWith("logout");
		expect(context.handleVeyraLogout).not.toHaveBeenCalled();
	});

	it("/logout <provider> opens the provider selector filtered, even when signed in to Veyra", async () => {
		const context = submitContext({ signedIn: true });
		await submit(context, "/logout anthropic");
		expect(context.showOAuthSelector).toHaveBeenCalledWith("logout", "anthropic");
		expect(context.handleVeyraLogout).not.toHaveBeenCalled();
	});

	it("/org and /org switch go to the organization command", async () => {
		const context = submitContext({ signedIn: true });
		await submit(context, "/org");
		await submit(context, "/org switch");
		expect(context.handleOrgCommand.mock.calls).toEqual([[""], ["switch"]]);
		expect(context.session.prompt).not.toHaveBeenCalled();
	});
});

describe("the Veyra sign-in while a run streams", () => {
	it("/login, /logout and /org switch wait for the run: a warning, and the command stays in the editor", async () => {
		const context = submitContext({ signedIn: true });
		context.session.isStreaming = true;
		for (const command of ["/login", "/logout", "/org switch"]) await submit(context, command);
		expect(context.handleVeyraLogin).not.toHaveBeenCalled();
		expect(context.handleVeyraLogout).not.toHaveBeenCalled();
		expect(context.handleOrgCommand).not.toHaveBeenCalled();
		expect(context.session.prompt).not.toHaveBeenCalled();
		expect(context.showWarning).toHaveBeenCalledTimes(3);
		expect(String(context.showWarning.mock.calls[0]![0])).toContain("A run is going on");
		expect(context.editor.setText.mock.calls).toEqual([["/login"], ["/logout"], ["/org switch"]]);
	});

	it("what does not change the organization still works during a run", async () => {
		const context = submitContext({ signedIn: true });
		context.session.isStreaming = true;
		await submit(context, "/org");
		await submit(context, "/login anthropic");
		await submit(context, "/logout anthropic");
		expect(context.handleOrgCommand.mock.calls).toEqual([[""]]);
		expect(context.handleLoginCommand).toHaveBeenCalledWith("anthropic");
		expect(context.showOAuthSelector).toHaveBeenCalledWith("logout", "anthropic");
		expect(context.showWarning).not.toHaveBeenCalled();
	});
});

describe("/org", () => {
	it("shows the organization, tier, group and Connect", async () => {
		const auth = fakeAuth();
		const context = accountContext(auth);
		await prototype.handleOrgCommand.call(context, "");
		expect(auth.organization).toHaveBeenCalledTimes(1);
		expect(context.startEdition).toHaveBeenCalledWith({ askConnect: false });
		expect(context.showStatus).toHaveBeenCalledWith(
			"org Acme Robotics (acme) · tier medium · group Editor · Connect https://connect.veyra.so\n" +
				"ee on: token saving\n" +
				"/org switch signs in again and lets you pick another organization on Connect's page.",
		);
	});

	it("/org switch signs in again without looking the organization up", async () => {
		const auth = fakeAuth();
		const context = accountContext(auth);
		await prototype.handleOrgCommand.call(context, "switch");
		expect(context.handleVeyraLogin).toHaveBeenCalledTimes(1);
		expect(auth.organization).not.toHaveBeenCalled();
	});

	it("not signed in: says how to sign in and starts nothing", async () => {
		const auth = fakeAuth({ account: vi.fn(() => undefined) });
		const context = accountContext(auth, { signedIn: false });
		await prototype.handleOrgCommand.call(context, "switch");
		expect(context.handleVeyraLogin).not.toHaveBeenCalled();
		expect(context.showStatus.mock.calls[0]?.[0]).toMatch(/^Not signed in to Veyra\. \/login signs you in/);
	});

	it("an unknown option is a warning", async () => {
		const context = accountContext(fakeAuth());
		await prototype.handleOrgCommand.call(context, "list");
		expect(context.showWarning).toHaveBeenCalledWith('Unknown /org option "list". Use /org or /org switch.');
	});

	it("Connect ended the sign-in: says to sign in again with /login", async () => {
		const auth = fakeAuth({
			organization: vi.fn(async () => {
				throw new VeyraSignedOutError("session_ended");
			}),
		});
		const context = accountContext(auth);
		await prototype.handleOrgCommand.call(context, "");
		expect(context.showWarning).toHaveBeenCalledWith("Your Veyra sign-in has ended. Run /login again.");
		expect(context.veyraAccount).toBeUndefined();
	});

	it("neutralizes terminal escapes in the organization's name, code, tier and group", async () => {
		const auth = fakeAuth({
			organization: vi.fn(async () => ({
				...ORG,
				name: `${OSC52}Acme\u001b[2J Robotics`,
				code: "acme\u001b[1A",
				tier: "medium\u0007",
				groupName: `Editor${OSC52}`,
			})),
		});
		const context = accountContext(auth);
		await prototype.handleOrgCommand.call(context, "");
		const [line] = shown(context);
		expect(line).toContain("Acme");
		expect(line).toContain("Editor");
		// The only control character left is the line break between the two lines of the message.
		for (const part of String(line).split("\n")) expect(part).not.toMatch(CONTROL);
	});

	it("neutralizes terminal escapes in an error from Connect", async () => {
		const auth = fakeAuth({
			organization: vi.fn(async () => {
				throw new Error(`403 forbidden: ${OSC52}denied`);
			}),
		});
		const context = accountContext(auth);
		await prototype.handleOrgCommand.call(context, "");
		const [line] = shown(context);
		expect(line).toContain("not checked now: 403 forbidden");
		for (const part of String(line).split("\n")) expect(part).not.toMatch(CONTROL);
	});
});

describe("/logout (Veyra)", () => {
	it("revokes, clears the account from the status line and says so", async () => {
		const auth = fakeAuth();
		const context = accountContext(auth);
		const clear = vi.spyOn(veyraModelConnections, "clear");
		await prototype.handleVeyraLogout.call(context);
		// No model connection of the signed-out organization stays in /model (F13).
		expect(clear).toHaveBeenCalledTimes(1);
		expect(auth.logout).toHaveBeenCalledTimes(1);
		// The revoke's 15 s start at the revoke, after any wait for the lock: no timer is started up front.
		expect(auth.logout).toHaveBeenCalledWith({ revokeTimeoutMs: 15_000 });
		expect(context.veyraAccount).toBeUndefined();
		expect(context.editionGate.setEntitlement).toHaveBeenCalledWith(expect.objectContaining({ signedIn: false }));
		expect(context.showStatus).toHaveBeenCalledWith(
			"Signed out of Veyra. Provider keys stay; /logout <provider> removes one.",
		);
	});

	it("a sign-out that fails is reported, not thrown", async () => {
		const auth = fakeAuth({
			logout: vi.fn(async () => {
				throw new Error("The macOS Keychain refused the change");
			}),
		});
		const context = accountContext(auth);
		await expect(prototype.handleVeyraLogout.call(context)).resolves.toBeUndefined();
		expect(context.showError).toHaveBeenCalledWith(
			"Could not sign out of Veyra: The macOS Keychain refused the change",
		);
	});

	it("a lock another fingers process held: says the sign-in was removed without it", async () => {
		const auth = fakeAuth({
			logout: vi.fn(
				async (): Promise<VeyraLogoutResult> => ({
					signedIn: true,
					revocation: "revoked",
					lockProblem: "Lock file is already being held",
				}),
			),
		});
		const context = accountContext(auth);
		await prototype.handleVeyraLogout.call(context);
		expect(context.veyraAccount).toBeUndefined();
		expect(shown(context).join("\n")).toMatch(/lock/i);
		expect(shown(context).join("\n")).toContain("Signed out of Veyra");
	});

	it("neutralizes terminal escapes in a failed revocation's detail", async () => {
		const auth = fakeAuth({
			logout: vi.fn(
				async (): Promise<VeyraLogoutResult> => ({
					signedIn: true,
					revocation: "failed",
					detail: `invalid_request: ${OSC52}nope`,
				}),
			),
		});
		const context = accountContext(auth);
		await prototype.handleVeyraLogout.call(context);
		const [line] = shown(context);
		expect(line).toContain("invalid_request");
		expect(line).not.toMatch(CONTROL);
	});
});

describe("Connect's strings on the terminal app's screen", () => {
	it("the status line's account has no terminal escapes", () => {
		const status = prototype.getVeyraAccountStatus.call({
			veyraAccount: { ...ACCOUNT, email: `ada${OSC52}@example.com`, orgName: "Acme\u001b[2J Robotics" },
		});
		expect(status?.signedIn).toBe(true);
		expect(status?.email).toContain("@example.com");
		expect(status?.email).not.toMatch(CONTROL);
		expect(status?.org).toContain("Robotics");
		expect(status?.org).not.toMatch(CONTROL);
	});

	it("a sign-in error with escapes in Connect's description is shown neutralized", async () => {
		const auth = fakeAuth({
			login: vi.fn(async () => {
				throw new DeviceFlowError(
					"failed",
					`Connect refused the sign-in: ${OSC52}bad\u001b[2J.`,
					"invalid_request",
				);
			}),
		});
		const context = accountContext(auth, { signedIn: false });
		expect(await prototype.handleVeyraLogin.call(context)).toBe(false);
		const [line] = context.showError.mock.calls.map(([message]) => String(message));
		expect(line).toContain("Connect refused the sign-in");
		expect(line).not.toMatch(CONTROL);
	});
});

describe("/login and the organization's model connections (F13, canvas FingersTuiLogin)", () => {
	afterEach(() => vi.restoreAllMocks());

	const LIST: ModelConnectionsList = {
		org: "org_7aR2cT",
		offered: ["Claude", "OpenAI", "OpenRouter"].map((name, index) => ({
			connection: {
				id: `mc_${index}`,
				provider: "anthropic",
				auth: "api_key",
				name,
				apps: [],
				groups: [],
				capabilities: [],
				models: [],
			},
			route: { wire: "anthropic", fingersProvider: "anthropic", label: "Anthropic", subscription: true },
			providerId: `veyra-mc_${index}`,
			displayName: `${name} (Veyra)`,
		})),
		notOffered: [],
	};

	it("shows the connections line between the signed-in line and the ee line", async () => {
		initTheme("dark");
		const context = accountContext(fakeAuth(), { signedIn: false });
		context.loadModelConnections.mockResolvedValue(LIST);
		expect(await prototype.handleVeyraLogin.call(context)).toBe(true);
		expect(context.loadModelConnections).toHaveBeenCalledTimes(1);
		const lines = chatLines(context).map((line) => line.trim());
		expect(lines[0]).toMatch(/^✓ Signed in as ada@example.com/);
		expect(lines[1]).toBe("✓ 3 model connections from Connect: Claude, OpenAI, OpenRouter");
		expect(lines[2]).toMatch(/^✓ ee features on: /);
		expect(lines[3]).toMatch(/^Token stored in your OS keychain/);
	});

	it("says why when Connect gave no list", async () => {
		initTheme("dark");
		const context = accountContext(fakeAuth(), { signedIn: false });
		context.loadModelConnections.mockImplementation(async function (this: AccountContext) {
			this.modelConnectionsProblem =
				"Your group (Viewer) in Acme Robotics may not see model connections (Connect models:read). Ask an admin of the organization.";
			return undefined;
		});
		expect(await prototype.handleVeyraLogin.call(context)).toBe(true);
		expect(chatLines(context).map((line) => line.trim())[1]).toBe(
			"Model connections not loaded: Your group (Viewer) in Acme Robotics may not see model connections (Connect models:read). Ask an admin of the organization.",
		);
	});
});

describe("/login racing a sign-out (F11a)", () => {
	it("another fingers process signed out at the same moment: says the sign-in was not kept and to run /login again", async () => {
		const auth = fakeAuth({
			login: vi.fn(async () => {
				throw new VeyraSessionClearedError();
			}),
		});
		const context = accountContext(auth, { signedIn: false });
		expect(await prototype.handleVeyraLogin.call(context)).toBe(false);
		expect(shown(context)).toEqual([
			"Another fingers process signed out at the same moment, so this sign-in was not kept. Run /login again.",
		]);
		expect(context.showWarning).toHaveBeenCalledTimes(1);
		expect(context.veyraAccount).toBeUndefined();
	});
});

describe("the terminal app's ee gate", () => {
	it("hands ee features the process' tool hooks and savings ledger, which the built-in edition extension uses", () => {
		const context: { editionGate?: unknown } = {};
		const gate = (
			InteractiveMode.prototype as unknown as { getEditionGate(this: object): unknown }
		).getEditionGate.call(context);
		const options = (gate as { options: { toolHooks?: unknown; savings?: unknown } }).options;
		expect(options.toolHooks).toBe(editionToolHooks);
		expect(options.savings).toBe(savingsLedger);
	});
});
