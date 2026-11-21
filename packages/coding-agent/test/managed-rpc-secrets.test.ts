/**
 * Which host values managed mode treats as secrets, and that removing them never changes a JSON record's
 * structure (values only), so a short value can never turn `"success":true` into invalid JSON.
 */
import { describe, expect, it } from "vitest";
import { ManagedLogger } from "../src/modes/rpc/managed/log.ts";
import { SecretSet, secretHeaderValues } from "../src/modes/rpc/managed/secrets.ts";

describe("secretHeaderValues", () => {
	it("keeps only credential-named headers with values of 8 characters or more (the Hands rule)", () => {
		const values = secretHeaderValues({
			Authorization: "Bearer abcdefghijklmnop",
			"x-api-key": "sk-1234567890",
			"x-conformance-secret": "header-secret-value",
			"anthropic-version": "2023-06-01",
			"x-flag": "true",
			"x-session-token": "short",
			"x-veyra-proxy-route": "rt_5f1c9a7e3b2d",
		});
		expect(values.sort()).toEqual(["Bearer abcdefghijklmnop", "header-secret-value", "sk-1234567890"]);
	});

	it("matches the credential header names and name parts case-insensitively", () => {
		const long = "value-0123456789";
		for (const name of [
			"Cookie",
			"Proxy-Authorization",
			"API-KEY",
			"X-Auth-Context",
			"x-goog-api-key",
			"X-Password",
			"x-amz-security-token",
			"x-session-id",
			"x-signature",
			"x-client-credential",
			"X-Secret",
		]) {
			expect(secretHeaderValues({ [name]: long }), name).toEqual([long]);
		}
		expect(secretHeaderValues(undefined)).toEqual([]);
		expect(secretHeaderValues({ "content-type": "application/json", "user-agent": "veyra-hands/1.0.0" })).toEqual([]);
	});
});

describe("SecretSet keeps JSON structure", () => {
	it("redacts values and keys of a record but never its literals or punctuation", () => {
		const secrets = new SecretSet();
		secrets.add("true");
		secrets.add('","success":false,"x":"');
		const record = { type: "response", success: true, note: 'it is true","success":false,"x":"', n: 1 };
		expect(secrets.redactValue(record)).toEqual({
			type: "response",
			success: true,
			note: "it is [redacted][redacted]",
			n: 1,
		});
		secrets.add("hpt_key_in_a_key_123");
		expect(secrets.redactValue({ "x hpt_key_in_a_key_123": 1 } as Record<string, number>)).toEqual({
			"x [redacted]": 1,
		});
	});

	it("redactJsonLine rewrites values only and stays valid JSON", () => {
		const secrets = new SecretSet();
		secrets.add("true");
		secrets.add("null,");
		const line = JSON.stringify({ success: true, data: null, list: [true, "true story", "null, really"] });
		const out = secrets.redactJsonLine(line);
		expect(JSON.parse(out)).toEqual({
			success: true,
			data: null,
			list: [true, "[redacted] story", "[redacted] really"],
		});
		// A line that is not JSON falls back to text redaction.
		expect(secrets.redactJsonLine("plain true text")).toBe("plain [redacted] text");
	});

	it("logs with a short credential stay valid JSON", () => {
		const lines: string[] = [];
		const secrets = new SecretSet();
		secrets.add("info");
		const logger = new ManagedLogger({ write: (line) => lines.push(line), secrets, version: "0.1.0", env: "test" });
		logger.info("credentials received", { provider: "anthropic", ok: true, count: 3 });
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0]!);
		expect(record).toMatchObject({ ok: true, count: 3, provider: "anthropic" });
	});
});
