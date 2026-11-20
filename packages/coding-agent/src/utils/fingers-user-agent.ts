import { formatUserAgent } from "@veyraco/fingers-ai";

/** fingers' `User-Agent` for its own network requests; the same detailed form fingers-ai sends to providers. */
export function getFingersUserAgent(version: string): string {
	return formatUserAgent({ userAgent: "detailed", version });
}
