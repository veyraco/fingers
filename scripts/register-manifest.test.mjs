// Fingers' permission manifest (manifest/fingers.json) and its registration with Veyra Connect
// (scripts/register-manifest.mjs). The fake Connect below checks a registration the way Connect's
// internal listener does (src/http/instance-jwt.ts in veyraco/connect): application/jwt, header
// exactly {alg: EdDSA, typ: veyra-manifest+jwt[, kid]}, the instance's Ed25519 signature,
// aud connect, at most 300 s from iat to exp, a jti spent once.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
	buildRegistration,
	checkManifest,
	jwkThumbprint,
	loadInstance,
	ManifestError,
	RegistrationError,
	readManifest,
	registerManifest,
	signRegistration,
} from "./register-manifest.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = fileURLToPath(new URL("./register-manifest.mjs", import.meta.url));
const require = createRequire(import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const sha256 = (path) =>
	createHash("sha256")
		.update(readFileSync(join(root, path)))
		.digest("hex");
const b64json = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));

function newInstance(id = "inst_localfingers") {
	const { privateKey } = generateKeyPairSync("ed25519");
	const key = privateKey.export({ format: "jwk" });
	key.kid = jwkThumbprint(key);
	key.alg = "EdDSA";
	key.use = "sig";
	return { id, key };
}

const silent = { info() {}, warn() {}, error() {} };

function collectingLogger() {
	const lines = [];
	const at = (level) => (fields, msg) => lines.push({ level, msg, ...fields });
	return { lines, logger: { info: at("info"), warn: at("warn"), error: at("error") } };
}

/** Verifies a registration like Connect; returns {status, problem?, payload?}. */
function connectCheck(instance, spent, contentType, body, nowS = Math.floor(Date.now() / 1000)) {
	if ((contentType ?? "").split(";")[0].trim().toLowerCase() !== "application/jwt")
		return { status: 400, code: "invalid_request" };
	const parts = body.trim().split(".");
	if (parts.length !== 3) return { status: 400, code: "invalid_request" };
	const header = b64json(parts[0]);
	const payload = b64json(parts[1]);
	if (header.alg !== "EdDSA" || header.typ !== "veyra-manifest+jwt") return { status: 400, code: "invalid_request" };
	if (Object.keys(header).some((k) => !["alg", "typ", "kid"].includes(k)))
		return { status: 400, code: "invalid_request" };
	if (payload.iss !== instance.id) return { status: 401, code: "unauthenticated" };
	const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: instance.key.x }, format: "jwk" });
	const ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], "base64url"));
	if (!ok) return { status: 401, code: "unauthenticated" };
	if (payload.aud !== "connect") return { status: 401, code: "unauthenticated" };
	const { iat, exp } = payload;
	if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp <= iat || exp - iat > 300) {
		return { status: 401, code: "unauthenticated" };
	}
	if (iat > nowS + 30 || exp < nowS - 30) return { status: 401, code: "unauthenticated" };
	if (typeof payload.jti !== "string" || payload.jti.length === 0 || payload.jti.length > 200) {
		return { status: 400, code: "invalid_request" };
	}
	if (spent.has(payload.jti)) return { status: 401, code: "unauthenticated" };
	spent.add(payload.jti);
	if (payload.app !== "fingers" || payload.manifest?.app !== "fingers")
		return { status: 403, code: "permission_denied" };
	return { status: 201, header, payload };
}

/** A fake Connect internal listener answering each registration from `answers` (last one repeats). */
async function fakeConnect(t, instance, answers) {
	const spent = new Set();
	const seen = [];
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const checked = connectCheck(instance, spent, req.headers["content-type"], body);
			seen.push({ method: req.method, url: req.url, headers: req.headers, body, checked });
			const planned = answers[Math.min(seen.length - 1, answers.length - 1)];
			const status = checked.status === 201 ? planned.status : checked.status;
			const code = checked.status === 201 ? planned.code : checked.code;
			res.writeHead(status, {
				"content-type": status < 300 ? "application/json" : "application/problem+json",
			});
			res.end(
				JSON.stringify(
					status < 300
						? checked.payload.manifest
						: { code, detail: planned.detail ?? `refused (${status})`, status },
				),
			);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

function runCli(args, env = {}) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [script, ...args], {
			env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c) => {
			stdout += c;
		});
		child.stderr.on("data", (c) => {
			stderr += c;
		});
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
}

describe("manifest/fingers.json", () => {
	it("is the pinned copy of the platform contract (manifest and schema hashes match manifest/SOURCE.json)", () => {
		const source = readJson("manifest/SOURCE.json");
		assert.equal(source.repository, "veyraco/platform");
		assert.match(source.commit, /^[0-9a-f]{40}$/);
		assert.deepEqual(Object.keys(source.files).sort(), [
			"manifest/fingers.json",
			"manifest/permission-manifest.schema.json",
		]);
		assert.equal(source.files["manifest/fingers.json"].from, "contracts/openapi/manifests/fingers.json");
		assert.equal(
			source.files["manifest/permission-manifest.schema.json"].from,
			"contracts/v1/schemas/permission-manifest.schema.json",
		);
		for (const [path, pin] of Object.entries(source.files)) assert.equal(sha256(path), pin.sha256, path);
	});

	it("validates against the permission-manifest JSON Schema", () => {
		const Ajv2020 = require("ajv/dist/2020.js").default;
		const ajv = new Ajv2020({ allErrors: true, strict: false });
		const validate = ajv.compile(readJson("manifest/permission-manifest.schema.json"));
		const manifest = readJson("manifest/fingers.json");
		assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
		const broken = clone(manifest);
		broken.defaults.owner = ["cli:use"];
		assert.equal(validate(broken), false);
	});

	it("passes the loader's cross-field rules and is Fingers' manifest", () => {
		const manifest = readManifest();
		const loaded = checkManifest(manifest, "fingers");
		assert.equal(loaded.app, "fingers");
		assert.ok(loaded.version >= 1);
		// fingers login and the ee gate check this permission.
		assert.equal(loaded.permissions.get("cli:use")?.access, "write");
		// Viewers get read access only; Owner and Admin everything.
		for (const id of loaded.defaultGrants.viewer) assert.equal(loaded.permissions.get(id).access, "read", id);
		assert.equal(loaded.defaultGrants.owner.size, loaded.permissions.size);
		assert.ok(loaded.defaultGrants.editor.has("cli:use"));
		assert.ok(!loaded.defaultGrants.editor.has("hooks:manage"));
	});

	it("refuses manifests the platform loader refuses", () => {
		const manifest = readManifest();
		const cases = [
			["duplicate_permission", (m) => m.permissions.push(clone(m.permissions[0]))],
			["duplicate_area", (m) => m.areas.push(clone(m.areas[0]))],
			[
				"unknown_area",
				(m) => {
					m.permissions[0].area = "nowhere";
				},
			],
			["unknown_area", (m) => m.defaults.editor.push("area:nowhere")],
			["unknown_permission", (m) => m.defaults.editor.push("cli:fly")],
			[
				"invalid_shape",
				(m) => {
					m.defaults.owner = ["cli:use"];
				},
			],
			[
				"invalid_shape",
				(m) => {
					m.defaults.viewer = ["access:read", "access:read"];
				},
			],
			[
				"invalid_shape",
				(m) => {
					m.permissions[0].id = "CliUse";
				},
			],
			[
				"invalid_shape",
				(m) => {
					m.permissions[0].access = "admin";
				},
			],
			[
				"invalid_shape",
				(m) => {
					m.version = 0;
				},
			],
			[
				"invalid_shape",
				(m) => {
					m.extra = true;
				},
			],
			["invalid_shape", (m) => delete m.defaults.billing],
			[
				"invalid_shape",
				(m) => {
					m.title = "";
				},
			],
		];
		for (const [code, mutate] of cases) {
			const broken = clone(manifest);
			mutate(broken);
			assert.throws(
				() => checkManifest(broken, "fingers"),
				(err) => err instanceof ManifestError && err.code === code,
				`${code}: ${mutate}`,
			);
		}
		const other = clone(manifest);
		other.app = "hands";
		assert.throws(
			() => checkManifest(other, "fingers"),
			(err) => err instanceof ManifestError && err.code === "wrong_app",
		);
	});
});

describe("instance identity", () => {
	it("reads VEYRA_INSTANCE_ID and VEYRA_INSTANCE_KEY", () => {
		const { id, key } = newInstance();
		const instance = loadInstance({ env: { VEYRA_INSTANCE_ID: id, VEYRA_INSTANCE_KEY: JSON.stringify(key) } });
		assert.equal(instance.id, id);
		assert.equal(instance.key.d, key.d);
	});

	it("reads the instance file Connect's dev seed writes", (t) => {
		const dir = mkdtempSync(join(tmpdir(), "fingers-instance-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const { id, key } = newInstance();
		const file = join(dir, "fingers.json");
		writeFileSync(
			file,
			JSON.stringify({ app: "fingers", instanceId: id, environment: "development", signingKey: key }),
		);
		const instance = loadInstance({ env: {}, file });
		assert.equal(instance.id, id);
		assert.equal(instance.key.kid, key.kid);

		writeFileSync(file, JSON.stringify({ app: "hands", instanceId: id, signingKey: key }));
		assert.throws(() => loadInstance({ env: {}, file }), /fingers/);
	});

	it("refuses a missing, malformed or public-only key, and a bad instance id", () => {
		const { id, key } = newInstance();
		const { d: _d, ...publicOnly } = key;
		const bad = [
			{},
			{ VEYRA_INSTANCE_ID: id },
			{ VEYRA_INSTANCE_KEY: JSON.stringify(key) },
			{ VEYRA_INSTANCE_ID: "fingers-1", VEYRA_INSTANCE_KEY: JSON.stringify(key) },
			{ VEYRA_INSTANCE_ID: id, VEYRA_INSTANCE_KEY: "not json" },
			{ VEYRA_INSTANCE_ID: id, VEYRA_INSTANCE_KEY: JSON.stringify(publicOnly) },
			{ VEYRA_INSTANCE_ID: id, VEYRA_INSTANCE_KEY: JSON.stringify({ kty: "RSA", n: "x", e: "AQAB", d: "x" }) },
		];
		for (const env of bad) {
			assert.throws(
				() => loadInstance({ env }),
				(err) => {
					assert.ok(!String(err.message).includes(key.d), "the private key never appears in an error");
					return true;
				},
				JSON.stringify(Object.keys(env)),
			);
		}
	});
});

describe("signed registration", () => {
	it("builds AppRegistration for Fingers: no meters, no notification kinds, a fresh jti, 60 s lifetime", () => {
		const manifest = readManifest();
		const a = buildRegistration("inst_localfingers", manifest, 1_800_000_000_000);
		const b = buildRegistration("inst_localfingers", manifest, 1_800_000_000_000);
		assert.deepEqual(Object.keys(a).sort(), [
			"app",
			"aud",
			"exp",
			"iat",
			"iss",
			"jti",
			"manifest",
			"meters",
			"notification_kinds",
		]);
		assert.equal(a.iss, "inst_localfingers");
		assert.equal(a.aud, "connect");
		assert.equal(a.app, "fingers");
		assert.equal(a.iat, 1_800_000_000);
		assert.equal(a.exp - a.iat, 60);
		assert.deepEqual(a.meters, []);
		assert.deepEqual(a.notification_kinds, []);
		assert.deepEqual(a.manifest, manifest);
		assert.notEqual(a.jti, b.jti);
	});

	it("signs a compact JWS Connect accepts, header {alg, typ, kid} with the RFC 7638 thumbprint", () => {
		const instance = newInstance();
		const jws = signRegistration(instance, buildRegistration(instance.id, readManifest(), Date.now()));
		const checked = connectCheck(instance, new Set(), "application/jwt", jws);
		assert.equal(checked.status, 201, JSON.stringify(checked));
		assert.deepEqual(checked.header, { alg: "EdDSA", typ: "veyra-manifest+jwt", kid: instance.key.kid });

		// A key without kid gets its thumbprint; the RFC 8037 A.3 example vector holds.
		const { kid: _kid, ...noKid } = instance.key;
		const jws2 = signRegistration(
			{ id: instance.id, key: noKid },
			buildRegistration(instance.id, readManifest(), Date.now()),
		);
		assert.equal(b64json(jws2.split(".")[0]).kid, instance.key.kid);
		assert.equal(
			jwkThumbprint({ kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" }),
			"kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k",
		);

		// Tampering with the payload breaks the signature.
		const [h, p, s] = jws.split(".");
		const payload = b64json(p);
		payload.manifest.version += 1;
		const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`;
		assert.equal(connectCheck(instance, new Set(), "application/jwt", forged).status, 401);
	});
});

describe("registerManifest", () => {
	it("retries 503, 429 and network errors with a new signature each time, then reports 'registered'", async (t) => {
		const instance = newInstance();
		const connect = await fakeConnect(t, instance, [{ status: 503 }, { status: 429 }, { status: 201 }]);
		const sleeps = [];
		let calls = 0;
		const flakyFetch = (url, init) => {
			calls += 1;
			if (calls === 1) return Promise.reject(new TypeError("fetch failed"));
			return fetch(url, init);
		};
		const { lines, logger } = collectingLogger();
		const outcome = await registerManifest({
			connectUrl: `${connect.url}/`,
			instance,
			manifest: readManifest(),
			logger,
			fetch: flakyFetch,
			sleep: async (ms) => sleeps.push(ms),
		});
		assert.equal(outcome, "registered");
		assert.deepEqual(sleeps, [1000, 2000, 4000]);
		assert.equal(connect.seen.length, 3);
		for (const request of connect.seen) {
			assert.equal(request.method, "POST");
			assert.equal(request.url, "/v1/permission-manifests");
			assert.equal(request.headers["content-type"], "application/jwt");
			assert.equal(request.checked.status, 201, "every attempt is a valid, unspent registration");
		}
		const jtis = new Set(connect.seen.map((r) => r.checked.payload.jti));
		assert.equal(jtis.size, 3);

		// Correlation (platform logging.md): one X-Request-Id for the whole registration, a child
		// traceparent of one trace on every attempt.
		const requestIds = new Set(connect.seen.map((r) => r.headers["x-request-id"]));
		assert.equal(requestIds.size, 1);
		const [requestId] = requestIds;
		assert.match(requestId, /^[A-Za-z0-9._:-]{1,128}$/);
		const parents = connect.seen.map((r) => r.headers.traceparent.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/));
		for (const match of parents) assert.ok(match, "traceparent is W3C version 00, sampled");
		assert.equal(new Set(parents.map((m) => m[1])).size, 1);
		assert.equal(new Set(parents.map((m) => m[2])).size, 3);

		const done = lines.find((l) => l.msg === "manifest registered");
		assert.equal(done.outcome, "registered");
		assert.equal(done.request_id, requestId);
		assert.equal(done.trace_id, parents[0][1]);
		assert.equal(done.manifest_version, readManifest().version);
		assert.equal(lines.filter((l) => l.level === "warn").length, 3);
		const logged = JSON.stringify(lines);
		assert.ok(!logged.includes(instance.key.d), "the private key is never logged");
		assert.ok(!logged.includes(connect.seen[0].body.split(".")[2]), "the signed body is never logged");
	});

	it("reports 'unchanged' when Connect already holds this version with the same content (200)", async (t) => {
		const instance = newInstance();
		const connect = await fakeConnect(t, instance, [{ status: 200 }]);
		const outcome = await registerManifest({
			connectUrl: connect.url,
			instance,
			manifest: readManifest(),
			logger: silent,
		});
		assert.equal(outcome, "unchanged");
		assert.equal(connect.seen.length, 1);
	});

	it("stops at a refusal (409 manifest_version_taken, 403, 401) without retrying", async (t) => {
		for (const answer of [
			{
				status: 409,
				code: "manifest_version_taken",
				detail: "Version 1 of fingers is registered with other content.",
			},
			{ status: 403, code: "permission_denied" },
		]) {
			const instance = newInstance();
			const connect = await fakeConnect(t, instance, [answer]);
			const sleeps = [];
			await assert.rejects(
				registerManifest({
					connectUrl: connect.url,
					instance,
					manifest: readManifest(),
					maxAttempts: 3,
					logger: silent,
					sleep: async (ms) => sleeps.push(ms),
				}),
				(err) =>
					err instanceof RegistrationError &&
					err.status === answer.status &&
					err.code === answer.code &&
					(answer.detail === undefined || err.message.includes(answer.detail)),
			);
			assert.equal(connect.seen.length, 1);
			assert.deepEqual(sleeps, []);
		}
		// A key Connect does not know: the fake answers 401 itself.
		const known = newInstance();
		const connect = await fakeConnect(t, known, [{ status: 201 }]);
		const stranger = { id: known.id, key: newInstance().key };
		await assert.rejects(
			registerManifest({ connectUrl: connect.url, instance: stranger, manifest: readManifest(), logger: silent }),
			(err) => err instanceof RegistrationError && err.status === 401,
		);
	});

	it("gives up after maxAttempts and caps the backoff at 60 s", async (t) => {
		const instance = newInstance();
		const connect = await fakeConnect(t, instance, [{ status: 502 }]);
		const sleeps = [];
		await assert.rejects(
			registerManifest({
				connectUrl: connect.url,
				instance,
				manifest: readManifest(),
				logger: silent,
				maxAttempts: 9,
				sleep: async (ms) => sleeps.push(ms),
			}),
			(err) =>
				err instanceof RegistrationError && err.status === 502 && /gave up after 9 attempts/.test(err.message),
		);
		assert.deepEqual(sleeps, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
	});

	it("refuses to send an invalid manifest", async (t) => {
		const instance = newInstance();
		const connect = await fakeConnect(t, instance, [{ status: 201 }]);
		const broken = readManifest();
		broken.defaults.editor.push("cli:fly");
		await assert.rejects(
			registerManifest({ connectUrl: connect.url, instance, manifest: broken, logger: silent }),
			(err) => err instanceof ManifestError,
		);
		assert.equal(connect.seen.length, 0);
	});
});

describe("register-manifest CLI", () => {
	it("--check validates the manifest and sends nothing", async () => {
		const result = await runCli(["--check"]);
		assert.equal(result.status, 0, result.stderr);
		const line = JSON.parse(result.stdout.trim().split("\n").at(-1));
		assert.equal(line.msg, "manifest valid");
		assert.equal(line.service, "fingers");
		assert.equal(line.level, "info");
		assert.match(line.time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
		assert.equal(line.app, "fingers");
	});

	it("registers with a dev-seed instance file and logs JSON lines (exit 0), refuses with exit 1", async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "fingers-instance-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const instance = newInstance();
		const file = join(dir, "fingers.json");
		writeFileSync(file, JSON.stringify({ app: "fingers", instanceId: instance.id, signingKey: instance.key }));

		const ok = await fakeConnect(t, instance, [{ status: 201 }]);
		const result = await runCli(["--connect-url", ok.url, "--instance-file", file], { VEYRA_ENV: "local" });
		assert.equal(result.status, 0, result.stdout + result.stderr);
		const lines = result.stdout
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		const done = lines.find((l) => l.msg === "manifest registered");
		assert.equal(done.outcome, "registered");
		assert.equal(done.env, "local");
		assert.equal(done.request_id, ok.seen[0].headers["x-request-id"]);
		assert.ok(!result.stdout.includes(instance.key.d));

		const refused = await fakeConnect(t, instance, [{ status: 409, code: "manifest_version_taken" }]);
		const bad = await runCli([], {
			VEYRA_CONNECT_INTERNAL_URL: refused.url,
			VEYRA_INSTANCE_ID: instance.id,
			VEYRA_INSTANCE_KEY: JSON.stringify(instance.key),
		});
		assert.equal(bad.status, 1);
		const error = bad.stdout
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l))
			.find((l) => l.level === "error");
		assert.equal(error.code, "manifest_version_taken");
		assert.equal(error.http_status, 409);
		assert.ok(!bad.stdout.includes(instance.key.d));
	});

	it("exits 2 with usage when the Connect URL or the instance is missing", async () => {
		const result = await runCli([]);
		assert.equal(result.status, 2);
		assert.match(result.stderr, /VEYRA_CONNECT_INTERNAL_URL|--connect-url/);
		const unknown = await runCli(["--bogus"]);
		assert.equal(unknown.status, 2);
	});
});
