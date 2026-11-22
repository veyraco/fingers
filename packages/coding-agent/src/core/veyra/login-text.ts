/**
 * The texts of the sign-in screen (canvas "Fingers · CLI & web", FingersTuiLogin), shared by `fingers login` in the
 * shell and `/login` in the terminal app.
 */

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

/** "Signed in as ada@acme.dev  ·  org Acme Robotics  ·  tier medium". */
export function signedInSummary(facts: SignedInFacts): string {
	let text = `Signed in as ${facts.email ?? facts.subject ?? "your Veyra account"}`;
	if (facts.orgName) text += `  ·  org ${facts.orgName}`;
	if (facts.tier) text += `  ·  tier ${facts.tier}`;
	return text;
}
