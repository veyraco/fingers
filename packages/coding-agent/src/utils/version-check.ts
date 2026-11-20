import { compare, valid } from "semver";
import { PACKAGE_NAME } from "../config.ts";
import { getFingersUserAgent } from "./fingers-user-agent.ts";
import { fetchWithRetry } from "./management-http.ts";

const NPM_REGISTRY_URL = "https://registry.npmjs.org";

/** The npm registry's `latest` release of a package. Fingers checks for updates here; it has no update service of its own. */
export function getLatestVersionUrl(packageName: string = PACKAGE_NAME): string {
	return `${NPM_REGISTRY_URL}/${packageName}/latest`;
}

const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestFingersRelease {
	version: string;
	packageName?: string;
	note?: string;
}

/** Include useful errno details hidden behind Node's generic "fetch failed" error. */
export function formatVersionCheckError(error: unknown): string {
	const rootMessage = error instanceof Error && error.message ? error.message : String(error);
	const cause = error instanceof Error ? error.cause : undefined;
	const causes = cause instanceof AggregateError ? cause.errors : cause === undefined ? [] : [cause];
	const codes = causes
		.map((value) =>
			typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
				? value.code
				: undefined,
		)
		.filter((code): code is string => code !== undefined);

	if (codes.length > 0) return `${rootMessage} (${[...new Set(codes)].join(", ")})`;
	const causeMessage = causes.find(
		(value): value is Error => value instanceof Error && Boolean(value.message),
	)?.message;
	return causeMessage ? `${rootMessage} (cause: ${causeMessage})` : rootMessage;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestFingersRelease(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<LatestFingersRelease | undefined> {
	if (process.env.FINGERS_OFFLINE) return undefined;

	const response = await fetchWithRetry(
		getLatestVersionUrl(),
		{
			headers: {
				"User-Agent": getFingersUserAgent(currentVersion),
				accept: "application/json",
			},
		},
		{
			maxRetries: options.retry ? 2 : 0,
			timeoutMs: options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS,
		},
	);
	if (!response.ok) return undefined;

	// The registry answers with the release's package.json.
	const data = (await response.json()) as { name?: unknown; version?: unknown };
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const packageName = typeof data.name === "string" && data.name.trim() ? data.name.trim() : undefined;
	return { version: data.version.trim(), packageName };
}

export async function getLatestFingersVersion(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<string | undefined> {
	return (await getLatestFingersRelease(currentVersion, options))?.version;
}

export async function checkForNewFingersVersion(currentVersion: string): Promise<LatestFingersRelease | undefined> {
	if (process.env.FINGERS_SKIP_VERSION_CHECK) return undefined;

	try {
		const latestRelease = await getLatestFingersRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
