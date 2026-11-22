/**
 * The ee gate's facts about the signed-in organization: its tier and whether it has the `fingers` app on, from
 * Connect's organization lookup (`GET <api>/connect/v1/organizations/{org}`).
 *
 * Connect's answer is kept with the sign-in in the OS keychain. When Connect can't be reached (offline, timeout,
 * 5xx), the kept answer counts for 72 hours after Connect gave it; after that every ee feature is off until Connect
 * answers again. A refusal (HTTP 4xx, a token Connect no longer takes) is final: nothing kept is used.
 */
import { connectText } from "../veyra/login-text.ts";
import { ConnectUnavailableError, VeyraApiError } from "../veyra/oidc-client.ts";
import type { VeyraAccount } from "../veyra/session-vault.ts";
import { VeyraAudienceError, type VeyraOrganization, VeyraSignedOutError } from "../veyra/veyra-auth.ts";
import { type EeEntitlement, SIGNED_OUT } from "./types.ts";

/** How long Connect's last answer keeps ee features on without reaching Connect again. */
export const EE_OFFLINE_GRACE_MS = 72 * 60 * 60 * 1000;

/** A cached answer stamped further ahead than this (a clock moved back) is not trusted. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Strings from Connect end up in the terminal (locked box, /org, whoami): no control or bidi characters. */
function shown(value: string | undefined): string | undefined {
	return connectText(value);
}

/** The part of VeyraAuth the gate needs (tests pass a fake). */
export interface EntitlementSource {
	account(): VeyraAccount | undefined;
	organization(options?: { signal?: AbortSignal }): Promise<VeyraOrganization>;
	forgetEntitlement(): Promise<void>;
}

/** The entitlement from what the keychain holds, without any request: what a start shows before Connect answers. */
export function cachedEntitlement(account: VeyraAccount | undefined, now: number): EeEntitlement {
	if (!account) return SIGNED_OUT;
	const base = { signedIn: true, org: shown(account.org), orgName: shown(account.orgName ?? account.org) };
	const checkedAt = account.entitlementCheckedAt;
	const fresh = checkedAt !== undefined && checkedAt <= now + CLOCK_SKEW_MS && now - checkedAt <= EE_OFFLINE_GRACE_MS;
	if (!fresh) return { ...base, source: "none", fingersEnabled: false, offline: true, checkedAt };
	return {
		...base,
		source: "cache",
		tier: shown(account.tier),
		fingersEnabled: account.fingersEnabled === true,
		checkedAt,
	};
}

/** True when the error means Connect could not be asked, rather than that it said no. */
function isUnreachable(error: unknown): boolean {
	if (error instanceof VeyraApiError) return error.status >= 500 || error.status === 429;
	if (error instanceof ConnectUnavailableError) return error.status === undefined || error.status >= 500;
	if (error instanceof VeyraSignedOutError || error instanceof VeyraAudienceError) return false;
	// fetch's TypeError (network), AbortError/TimeoutError, DNS and TLS failures.
	return true;
}

/**
 * The entitlement after an organization lookup: Connect's answer, the kept answer when Connect was unreachable, or
 * nothing when Connect refused (then `forget` says to drop the kept answer).
 */
export function entitlementAfterLookup(
	account: VeyraAccount,
	outcome: { org: VeyraOrganization } | { error: unknown },
	now: number,
): { entitlement: EeEntitlement; forget: boolean } {
	if ("org" in outcome) {
		const { org } = outcome;
		return {
			entitlement: {
				signedIn: true,
				source: "connect",
				org: shown(org.id),
				orgName: shown(org.name),
				tier: shown(org.tier),
				fingersEnabled: org.appsEnabled.includes("fingers"),
				checkedAt: now,
			},
			forget: false,
		};
	}
	const { error } = outcome;
	if (error instanceof VeyraSignedOutError) return { entitlement: SIGNED_OUT, forget: false };
	if (isUnreachable(error)) return { entitlement: cachedEntitlement(account, now), forget: false };
	return {
		entitlement: {
			signedIn: true,
			source: "none",
			org: shown(account.org),
			orgName: shown(account.orgName ?? account.org),
			fingersEnabled: false,
			denied: shown(error instanceof Error ? error.message : String(error)),
		},
		forget: true,
	};
}

/** Ask Connect for the organization's tier and apps; fall back to the kept answer only when Connect is unreachable. */
export async function resolveEntitlement(
	source: EntitlementSource,
	options: { now?: () => number; signal?: AbortSignal } = {},
): Promise<EeEntitlement> {
	const now = options.now ?? Date.now;
	let account: VeyraAccount | undefined;
	try {
		account = source.account();
	} catch {
		return SIGNED_OUT;
	}
	if (!account) return SIGNED_OUT;

	let outcome: { org: VeyraOrganization } | { error: unknown };
	try {
		outcome = { org: await source.organization({ signal: options.signal }) };
	} catch (error) {
		outcome = { error };
	}
	const { entitlement, forget } = entitlementAfterLookup(account, outcome, now());
	if (forget) await source.forgetEntitlement();
	return entitlement;
}
