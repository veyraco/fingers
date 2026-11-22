/**
 * The texts of the sign-in screen (canvas "Fingers · CLI & web", FingersTuiLogin), shared by `fingers login` in the
 * shell and `/login` in the terminal app.
 */
import { replaceControlCharacters } from "@veyraco/fingers-tui";

/** Bidirectional embedding, override and isolate controls: they reorder what follows them on the line. */
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]+/g;

/**
 * A string Connect controls (organization, tier, group, person name and email, error descriptions) made safe to print
 * in a terminal: each run of control characters (C0 and C1: ESC, OSC, CSI, BEL, newlines) or bidi controls becomes one
 * space, so it cannot move the cursor, set the clipboard (OSC 52), retitle the window, fake another line or reorder
 * the text around it.
 */
export function connectText(value: string): string;
export function connectText(value: string | undefined): string | undefined;
export function connectText(value: string | undefined): string | undefined {
	return value === undefined ? undefined : replaceControlCharacters(value).replace(BIDI_CONTROLS, " ");
}

/** An error's message for the screen; errors about Connect carry its error_description. */
export function connectErrorText(error: unknown): string {
	return connectText(error instanceof Error ? error.message : String(error));
}

/**
 * A fresh sign-in that another fingers process' sign-out (without the lock) overtook: the sign-out won, so nothing was
 * kept. `command` is how to sign in again (`fingers login`, `/login`).
 */
export function signInNotKeptText(command: string): string {
	return `Another fingers process signed out at the same moment, so this sign-in was not kept. Run ${command} again.`;
}

export const SIGN_IN_SUBTITLE = "Sign in with your Veyra account";
export const SIGN_IN_LEAD = "Sign in to Veyra Connect to use your organization’s model connections and ee features.";
export const CHECK_CODE_STEP = "2. Check that it shows this code, then confirm:";
export const WAITING_TEXT = "Waiting for you to confirm in the browser";
export const KEY_HINTS = "c copy code · o open the link again · esc cancel";
export const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;

/** "9:41": minutes and seconds left, rounded up so a fresh 10-minute code reads 10:00. */
export function formatCountdown(remainingMs: number): string {
	const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export interface SignedInFacts {
	email?: string;
	subject?: string;
	orgName?: string;
	tier?: string;
}

/** The facts with every string made safe to print (connectText). */
export function safeSignedInFacts(facts: SignedInFacts): SignedInFacts {
	return {
		email: connectText(facts.email),
		subject: connectText(facts.subject),
		orgName: connectText(facts.orgName),
		tier: connectText(facts.tier),
	};
}

/** "Signed in as ada@example.com  ·  org Acme Robotics  ·  tier medium". */
export function signedInSummary(facts: SignedInFacts): string {
	const safe = safeSignedInFacts(facts);
	let text = `Signed in as ${safe.email ?? safe.subject ?? "your Veyra account"}`;
	if (safe.orgName) text += `  ·  org ${safe.orgName}`;
	if (safe.tier) text += `  ·  tier ${safe.tier}`;
	return text;
}
