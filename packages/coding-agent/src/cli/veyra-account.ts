/**
 * `fingers login`, `fingers logout` and `fingers whoami`: the Veyra account in the shell. The login screen follows
 * the canvas artboard FingersTuiLogin. Provider credentials stay under `fingers auth`.
 */
import { replaceControlCharacters } from "@veyraco/fingers-tui";
import { APP_NAME, VERSION } from "../config.ts";
import {
	coreOnlyText,
	EditionGate,
	type EeFeatureId,
	type EeModule,
	entitlementAfterLookup,
	formatFeatureList,
	loadEeModule,
} from "../core/edition/index.ts";
import { connectedAppsUrl } from "../core/veyra/connect-config.ts";
import { type DeviceCodePrompt, DeviceFlowError } from "../core/veyra/device-flow.ts";
import {
	CHECK_CODE_STEP,
	connectErrorText,
	connectText,
	formatCountdown,
	KEY_HINTS,
	SIGN_IN_LEAD,
	SIGN_IN_SUBTITLE,
	SPINNER_FRAMES,
	signedInSummary,
	WAITING_TEXT,
} from "../core/veyra/login-text.ts";
import { ConnectUnavailableError } from "../core/veyra/oidc-client.ts";
import {
	VEYRA_REVOKE_TIMEOUT_MS,
	type VeyraAuth,
	type VeyraOrganization,
	VeyraSignedOutError,
} from "../core/veyra/veyra-auth.ts";
import { copyToClipboard } from "../utils/clipboard.ts";
import { browserIsLocal, launchBrowser, openBrowser } from "../utils/open-browser.ts";

export type VeyraLoginKey = "copy" | "open" | "cancel";

/** Terminal I/O for the account commands; tests replace it. */
export interface VeyraCliTerminal {
	interactive: boolean;
	write(line: string): void;
	error(line: string): void;
	openUrl(url: string): void;
	/** Open the browser and tell whether the launcher started (false: it could not be started at all). */
	launchUrl?(url: string): Promise<boolean>;
	/** False when a browser opened here would not reach the person (SSH, no display): the address is shown instead. */
	canOpenUrl?: boolean;
	copy?(text: string): Promise<void>;
	/** Replace the live status line (a terminal only); undefined clears it. */
	status?(line: string | undefined): void;
	/** Key presses while the code is shown; returns the function that stops listening. */
	onKey?(handler: (key: VeyraLoginKey) => void): () => void;
}

export interface VeyraAccountCommandOptions {
	terminal: VeyraCliTerminal;
	signal: AbortSignal;
	/** The sign-in for the Connect the command names (`--connect`), else FINGERS_CONNECT_URL or connect.veyra.so. */
	openAuth(connectUrl: string | undefined): VeyraAuth;
	now?: () => number;
	/** logout: how long the revocation request may take, counted from when it is sent (default 15 s). */
	revokeTimeoutMs?: number;
	/** Finds the ee module (default: this installation's, see core/edition/loader.ts). */
	loadEeModule?: () => Promise<EeModule | undefined>;
}

interface EeSummary {
	on: boolean;
	features: EeFeatureId[];
	/** Why Fingers is core only. */
	reason?: string;
}

/** Which ee features this sign-in has after the organization lookup (the ee gate, as the terminal app decides it). */
async function eeSummary(
	auth: VeyraAuth,
	outcome: { org: VeyraOrganization } | { error: unknown },
	options: VeyraAccountCommandOptions,
): Promise<EeSummary | undefined> {
	const account = auth.account();
	if (!account) return undefined;
	const { entitlement, forget } = entitlementAfterLookup(account, outcome, (options.now ?? Date.now)());
	if (forget) await auth.forgetEntitlement();
	const gate = new EditionGate({ loadModule: options.loadEeModule ?? (() => loadEeModule()) });
	await gate.setEntitlement(entitlement);
	const features = gate.onFeatures();
	return features.length > 0
		? { on: true, features }
		: { on: false, features, reason: coreOnlyText(gate.state("token_saving"), entitlement) };
}

export const VEYRA_ACCOUNT_COMMANDS = ["login", "logout", "whoami"] as const;
type VeyraAccountCommand = (typeof VEYRA_ACCOUNT_COMMANDS)[number];

const USAGE: Record<VeyraAccountCommand, string> = {
	login: `${APP_NAME} login [--no-browser] [--connect <url>]`,
	logout: `${APP_NAME} logout [--connect <url>]`,
	whoami: `${APP_NAME} whoami [--json] [--connect <url>]`,
};

export function isVeyraAccountCommand(args: string[]): boolean {
	return (VEYRA_ACCOUNT_COMMANDS as readonly string[]).includes(args[0] ?? "");
}

export function printVeyraAccountHelp(write: (line: string) => void): void {
	write(`Usage:
  ${USAGE.login}
  ${USAGE.whoami}
  ${USAGE.logout}

Sign in to your Veyra account with a device code: Fingers shows a code, you confirm it in the browser at Veyra
Connect and pick the organization. The sign-in is kept only in the OS keychain (macOS Keychain, Secret Service on
Linux, Windows Credential Manager). Model provider credentials are separate: see "${APP_NAME} auth --help".

Commands:
  login     Sign in with a device code; signing in again replaces the sign-in (another organization, too)
  whoami    Show the account, organization, tier and group
  logout    Revoke this device at Connect and remove the sign-in from the keychain

Options:
  --no-browser      Show the address to open instead of opening the browser
  --connect <url>   Another Veyra Connect (default https://connect.veyra.so, or FINGERS_CONNECT_URL);
                    the local stack is https://connect.veyra.localhost
  --json            whoami: print JSON`);
}

interface ParsedArgs {
	command: VeyraAccountCommand;
	connect?: string;
	noBrowser: boolean;
	json: boolean;
	help: boolean;
}

function parseArgs(args: string[]): ParsedArgs | { error: string } {
	const command = args[0] as VeyraAccountCommand;
	const parsed: ParsedArgs = { command, noBrowser: false, json: false, help: false };
	for (let index = 1; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--help" || arg === "-h") parsed.help = true;
		else if (arg === "--connect" && args[index + 1] !== undefined) parsed.connect = args[++index];
		else if (arg.startsWith("--connect=")) parsed.connect = arg.slice("--connect=".length);
		else if (arg === "--no-browser" && command === "login") parsed.noBrowser = true;
		else if (arg === "--json" && command === "whoami") parsed.json = true;
		else if (arg === "--offline") continue;
		else return { error: `Usage: ${USAGE[command]}` };
	}
	return parsed;
}

/** Run `fingers login|logout|whoami` and return the exit code. */
export async function runVeyraAccountCommand(args: string[], options: VeyraAccountCommandOptions): Promise<number> {
	const parsed = parseArgs(args);
	const { terminal } = options;
	if ("error" in parsed) {
		terminal.error(parsed.error);
		return 1;
	}
	if (parsed.help) {
		printVeyraAccountHelp((text) => terminal.write(text));
		return 0;
	}
	let auth: VeyraAuth;
	try {
		auth = options.openAuth(parsed.connect);
	} catch (error) {
		terminal.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
	if (parsed.command === "login") return login(auth, parsed, options);
	if (parsed.command === "logout") return logout(auth, options);
	return whoami(auth, parsed, options);
}

async function login(auth: VeyraAuth, parsed: ParsedArgs, options: VeyraAccountCommandOptions): Promise<number> {
	const { terminal } = options;
	const now = options.now ?? Date.now;
	const storage = auth.storage;
	if (!storage.persistent) {
		terminal.error(`${APP_NAME} keeps your Veyra sign-in only in the OS keychain, but ${storage.memoryReason}.`);
		terminal.error("Inside the Fingers terminal app, /login signs you in for that session only.");
		return 1;
	}

	const controller = new AbortController();
	const signal = AbortSignal.any([options.signal, controller.signal]);
	let stopKeys: (() => void) | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let ended = false;
	const stopLive = () => {
		ended = true;
		if (timer) clearInterval(timer);
		timer = undefined;
		stopKeys?.();
		stopKeys = undefined;
		terminal.status?.(undefined);
	};

	const onCode = (prompt: DeviceCodePrompt) => {
		const deadline = now() + prompt.expiresInSeconds * 1000;
		const target = prompt.verificationUriComplete ?? prompt.verificationUri;
		const browser = !parsed.noBrowser && terminal.canOpenUrl !== false;
		terminal.write("Veyra Fingers");
		terminal.write(`v${VERSION} · ${SIGN_IN_SUBTITLE}`);
		terminal.write("");
		terminal.write(SIGN_IN_LEAD);
		terminal.write("");
		const page = replaceControlCharacters(prompt.verificationUri);
		// The rest of the screen, once it is known whether the browser could be launched.
		const showCode = (browserOpened: boolean) => {
			if (ended) return;
			terminal.write(browserOpened ? `  1. Your browser opened ${page}` : `  1. Open ${page} in a browser`);
			terminal.write(`  ${CHECK_CODE_STEP}`);
			terminal.write("");
			terminal.write(`     ${replaceControlCharacters(prompt.userCode)}`);
			terminal.write("");
			if (terminal.status && terminal.onKey) {
				terminal.write(`  ${KEY_HINTS}`);
				stopKeys = terminal.onKey((key) => {
					if (key === "cancel") controller.abort();
					else if (key === "open") terminal.openUrl(target);
					else void terminal.copy?.(prompt.userCode).catch(() => {});
				});
				let frame = 0;
				const render = () =>
					`${SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length]} ${WAITING_TEXT}   code expires in ${formatCountdown(deadline - now())}`;
				terminal.status(render());
				timer = setInterval(() => terminal.status?.(render()), 1000);
				timer.unref?.();
			} else {
				terminal.write(
					`${SPINNER_FRAMES[0]} ${WAITING_TEXT} · code expires in ${formatCountdown(deadline - now())} · Ctrl+C cancels`,
				);
			}
		};
		if (!browser) {
			showCode(false);
			return;
		}
		// Never say "Your browser opened" when the launcher itself could not start (the terminal app does the same).
		if (terminal.launchUrl) {
			void terminal.launchUrl(target).then(
				(started) => showCode(started),
				() => showCode(false),
			);
		} else {
			terminal.openUrl(target);
			showCode(true);
		}
	};

	let account: Awaited<ReturnType<VeyraAuth["login"]>>;
	try {
		account = await auth.login({ onCode, signal });
	} catch (error) {
		stopLive();
		terminal.error(loginErrorMessage(error));
		return 1;
	}
	stopLive();

	let org: VeyraOrganization | undefined;
	let lookup: { org: VeyraOrganization } | { error: unknown };
	try {
		org = await auth.organization({ signal: AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) });
		lookup = { org };
	} catch (error) {
		// The sign-in worked; the summary shows the organization id instead.
		lookup = { error };
	}
	const ee = await eeSummary(auth, lookup, options);
	terminal.write("");
	terminal.write(
		`✓ ${signedInSummary({ email: account.email, subject: account.subject, orgName: org?.name ?? account.org, tier: org?.tier })}`,
	);
	if (ee?.on) terminal.write(`✓ ee features on: ${formatFeatureList(ee.features)}`);
	else if (ee) terminal.write(`  Core only: ${connectText(ee.reason)}`);
	terminal.write(
		`  Token stored in your OS keychain. Sign out with ${APP_NAME} logout or revoke the device in Connect.`,
	);
	return 0;
}

function loginErrorMessage(error: unknown): string {
	if (error instanceof DeviceFlowError) {
		if (error.reason === "denied") return "The sign-in was denied in the browser. Nothing was stored.";
		if (error.reason === "expired") return `The code expired before it was confirmed. Run ${APP_NAME} login again.`;
		if (error.reason === "cancelled") return "Sign-in cancelled.";
		// May carry Connect's error_description.
		return connectErrorText(error);
	}
	return `Could not sign in: ${connectErrorText(error)}`;
}

async function logout(auth: VeyraAuth, options: VeyraAccountCommandOptions): Promise<number> {
	const { terminal } = options;
	let result: Awaited<ReturnType<VeyraAuth["logout"]>>;
	try {
		// The revoke's timeout starts when the revoke is sent, after any wait for the lock.
		result = await auth.logout({
			signal: options.signal,
			revokeTimeoutMs: options.revokeTimeoutMs ?? VEYRA_REVOKE_TIMEOUT_MS,
		});
	} catch (error) {
		terminal.error(`Could not sign out of Veyra: ${connectErrorText(error)}`);
		return 1;
	}
	const apps = connectedAppsUrl(auth.issuer);
	if (result.lockProblem) {
		terminal.error(
			`Another ${APP_NAME} process held the sign-in's lock past the wait (${connectText(result.lockProblem)}). ` +
				"Signing out is safe to repeat, so the sign-in was removed from the keychain without the lock.",
		);
	}
	if (!result.signedIn) {
		terminal.write("Not signed in to Veyra.");
		return 0;
	}
	switch (result.revocation) {
		case "revoked":
			terminal.write(
				"Signed out of Veyra. Connect revoked this device, and the sign-in is gone from your OS keychain.",
			);
			return 0;
		case "unsupported":
			terminal.write(
				"Signed out of Veyra on this computer. Connect can't revoke the device from here yet, so it still lists it:",
			);
			terminal.write(`remove it under Connected apps, ${apps}`);
			return 0;
		case "failed":
			terminal.error(
				`Signed out of Veyra on this computer, but Connect could not revoke the device (${connectText(result.detail) ?? "unknown error"}).`,
			);
			terminal.error(`Remove it under Connected apps, ${apps}`);
			return 1;
		default:
			terminal.write("Signed out of Veyra.");
			return 0;
	}
}

async function whoami(auth: VeyraAuth, parsed: ParsedArgs, options: VeyraAccountCommandOptions): Promise<number> {
	const { terminal } = options;
	const account = auth.account();
	if (!account) {
		if (parsed.json) terminal.write(terminalSafeJson({ signed_in: false, issuer: auth.issuer }));
		else terminal.write(`Not signed in to Veyra. Run ${APP_NAME} login.`);
		return 1;
	}
	let org: VeyraOrganization | undefined;
	let orgProblem: string | undefined;
	let lookup: { org: VeyraOrganization } | { error: unknown };
	try {
		org = await auth.organization({ signal: AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) });
		lookup = { org };
	} catch (error) {
		if (error instanceof VeyraSignedOutError) {
			terminal.error(error.message);
			return 1;
		}
		lookup = { error };
		const detail = connectErrorText(error);
		orgProblem =
			error instanceof ConnectUnavailableError
				? `Connect could not be reached: ${detail}`
				: `not available: ${detail}`;
	}
	const storage = { persistent: account.storage.persistent, location: account.storage.location };
	const ee = await eeSummary(auth, lookup, options);

	// Without an answer from Connect, the facts kept from the last lookup.
	const shown = org ?? {
		id: account.org ?? "unknown",
		code: account.orgCode,
		name: account.orgName ?? account.org ?? "unknown",
		tier: account.tier,
		groupName: account.groupName ?? account.groupKey,
	};

	if (parsed.json) {
		const organization = {
			id: shown.id,
			code: shown.code,
			name: shown.name,
			tier: shown.tier,
			group: shown.groupName,
			...(orgProblem ? { error: orgProblem } : {}),
		};
		terminal.write(
			terminalSafeJson({
				signed_in: true,
				issuer: account.issuer,
				subject: account.subject,
				email: account.email,
				name: account.name,
				organization,
				ee: ee ? { on: ee.on, features: ee.features, ...(ee.reason ? { reason: ee.reason } : {}) } : undefined,
				storage,
			}),
		);
		return 0;
	}

	// Names, codes and tiers come from Connect: no terminal escapes reach the screen (JSON above escapes them).
	const who = connectText(account.email ?? account.subject);
	const name = connectText(account.name);
	const code = connectText(shown.code);
	terminal.write(`Signed in as ${who}${name ? ` (${name})` : ""}`);
	terminal.write(
		`  Organization  ${connectText(shown.name)}${code ? ` (${code})` : ""}${orgProblem ? ` · not checked now: ${orgProblem}` : ""}`,
	);
	if (shown.tier) terminal.write(`  Tier          ${connectText(shown.tier)}`);
	if (shown.groupName) terminal.write(`  Group         ${connectText(shown.groupName)}`);
	if (ee)
		terminal.write(
			`  ee            ${ee.on ? `on · ${formatFeatureList(ee.features)}` : `off · ${connectText(ee.reason)}`}`,
		);
	terminal.write(`  Connect       ${connectText(account.issuer)}`);
	terminal.write(`  Stored in     ${storage.location}`);
	return 0;
}

/**
 * Pretty JSON a terminal can't act on: JSON.stringify escapes U+0000-U+001F only, so DEL, the C1 controls (U+0080-
 * U+009F: CSI U+009B and OSC U+009D act in some terminals) and the bidi controls are escaped as \uXXXX too. Same JSON
 * values.
 */
function terminalSafeJson(value: unknown): string {
	return JSON.stringify(value, null, 2).replace(
		/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

/** The account commands' terminal on this process' stdin and stdout: a live status line and keys in a terminal. */
export function createProcessVeyraTerminal(): VeyraCliTerminal {
	const stdin = process.stdin;
	const tty = stdin.isTTY === true && process.stdout.isTTY === true;
	const terminal: VeyraCliTerminal = {
		interactive: tty,
		write: (line) => process.stdout.write(`${line}\n`),
		error: (line) => process.stderr.write(`${line}\n`),
		openUrl: (url) => openBrowser(url),
		launchUrl: launchBrowser,
		canOpenUrl: browserIsLocal(),
		copy: copyToClipboard,
	};
	if (!tty) return terminal;
	terminal.status = (line) => process.stdout.write(line === undefined ? "\r\x1b[2K" : `\r\x1b[2K${line}`);
	terminal.onKey = (handler) => {
		const onData = (data: Buffer) => {
			const chunk = data.toString("utf8");
			if (chunk === "\x1b" || chunk === "\x03") return handler("cancel");
			if (chunk.startsWith("\x1b")) return; // arrow keys and other sequences
			for (const char of chunk) {
				if (char === "c" || char === "C") handler("copy");
				else if (char === "o" || char === "O") handler("open");
				else if (char === "\x03") handler("cancel");
			}
		};
		stdin.setRawMode(true);
		stdin.resume();
		stdin.on("data", onData);
		return () => {
			stdin.off("data", onData);
			stdin.setRawMode(false);
			stdin.pause();
		};
	};
	return terminal;
}
