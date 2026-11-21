#!/usr/bin/env node
// Registers Fingers' permission manifest (manifest/fingers.json) with Veyra Connect.
//
// Fingers has no server, so nothing registers the manifest at boot the way the other apps do.
// A Fingers release runs this script once per environment, from a place that can reach Connect's
// internal listener (cluster DNS only), with the Fingers instance identity Connect knows:
//
//   node scripts/register-manifest.mjs [--connect-url URL] [--instance-file FILE] [--max-attempts N]
//   node scripts/register-manifest.mjs --check      # validate the manifest, send nothing
//
// Configuration: --connect-url or VEYRA_CONNECT_INTERNAL_URL (for example
// http://connect-internal.connect.svc:8081); the instance from --instance-file (the JSON file
// Connect's dev seed writes, .local/instances/fingers.json) or VEYRA_INSTANCE_ID and
// VEYRA_INSTANCE_KEY (an Ed25519 private JWK). VEYRA_ENV names the environment in log lines.
//
// The request (Connect's registerPermissionManifest): POST <url>/v1/permission-manifests,
// application/jwt, a compact JWS with header {alg: EdDSA, typ: veyra-manifest+jwt, kid} and payload
// AppRegistration {iss, aud: connect, app: fingers, jti, iat, exp, manifest, meters: [],
// notification_kinds: []}. Fingers is free inside a tier, so it reports no usage meters.
// Versions are immutable at Connect: other content at the same version is 409, so a change to the
// manifest needs a new version in veyraco/platform first (then copy it here and update SOURCE.json).
//
// Retries: a network error, 429 and 5xx back off 1 s, 2 s, 4 s ... up to 60 s, each attempt signed
// anew (Connect spends every jti). Any other answer is final. Exit codes: 0 registered or
// unchanged, 1 refused or gave up, 2 bad usage or configuration.
//
// No dependencies beyond Node, so a Job can run it from a plain node image.
import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = join(ROOT, "manifest", "fingers.json");
export const REGISTRATION_TYP = "veyra-manifest+jwt";

/** Lifetime of the registration JWS; Connect accepts at most 300 s. */
const LIFETIME_S = 60;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const TIMEOUT_MS = 10_000;
const INSTANCE_ID = /^inst_[A-Za-z0-9]+$/;

// ---------------------------------------------------------------------------------------------
// Manifest checks: the same rules as @veyraco/platform-manifest's loadManifest (the schema rules
// by hand, then unique ids, known areas and defaults naming known permissions), plus the app.

export class ManifestError extends Error {
	/** @param {"invalid_shape"|"duplicate_area"|"duplicate_permission"|"unknown_area"|"unknown_permission"|"wrong_app"} code */
	constructor(code, message) {
		super(message);
		this.name = "ManifestError";
		this.code = code;
	}
}

const APP_IDS = ["connect", "intelligence", "brain", "eyes", "hands", "fingers"];
const DEFAULT_GROUPS = ["owner", "admin", "billing", "editor", "viewer"];
const AREA_ID = /^[a-z][a-z0-9_-]*$/;
const PERMISSION_ID = /^[a-z][a-z0-9_.-]*:[a-z][a-z0-9_-]*$/;
const AREA_SELECTOR = /^area:([a-z][a-z0-9_-]*)$/;

const shape = (msg) => {
	throw new ManifestError("invalid_shape", msg);
};
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v, path, min, max) => {
	if (typeof v !== "string" || v.length < min || v.length > max)
		shape(`${path} must be a string of ${min}-${max} chars`);
	return v;
};
const onlyKeys = (o, allowed, path) => {
	for (const k of Object.keys(o)) if (!allowed.includes(k)) shape(`${path} has unknown field "${k}"`);
};

function checkShape(doc) {
	if (!isObj(doc)) shape("manifest must be an object");
	onlyKeys(doc, ["$schema", "app", "version", "title", "areas", "permissions", "defaults"], "manifest");
	if (doc.$schema !== undefined && typeof doc.$schema !== "string") shape("$schema must be a string");
	if (!APP_IDS.includes(doc.app)) shape("app must be a Veyra app id");
	if (typeof doc.version !== "number" || !Number.isInteger(doc.version) || doc.version < 1) {
		shape("version must be an integer >= 1");
	}
	str(doc.title, "title", 1, 60);
	if (!Array.isArray(doc.areas) || doc.areas.length === 0) shape("areas must be a non-empty array");
	doc.areas.forEach((a, i) => {
		if (!isObj(a)) shape(`areas[${i}] must be an object`);
		onlyKeys(a, ["id", "title", "description"], `areas[${i}]`);
		if (!AREA_ID.test(str(a.id, `areas[${i}].id`, 1, 60))) shape(`areas[${i}].id is not a valid area id`);
		str(a.title, `areas[${i}].title`, 1, 60);
		if (a.description !== undefined) str(a.description, `areas[${i}].description`, 0, 300);
	});
	if (!Array.isArray(doc.permissions) || doc.permissions.length === 0) shape("permissions must be a non-empty array");
	doc.permissions.forEach((p, i) => {
		if (!isObj(p)) shape(`permissions[${i}] must be an object`);
		onlyKeys(p, ["id", "area", "access", "description"], `permissions[${i}]`);
		if (!PERMISSION_ID.test(str(p.id, `permissions[${i}].id`, 1, 100))) {
			shape(`permissions[${i}].id must look like resource:verb`);
		}
		if (!AREA_ID.test(str(p.area, `permissions[${i}].area`, 1, 60)))
			shape(`permissions[${i}].area is not a valid area id`);
		if (p.access !== "read" && p.access !== "write") shape(`permissions[${i}].access must be read or write`);
		str(p.description, `permissions[${i}].description`, 1, 300);
	});
	if (!isObj(doc.defaults)) shape("defaults must be an object");
	onlyKeys(doc.defaults, DEFAULT_GROUPS, "defaults");
	for (const g of DEFAULT_GROUPS) {
		const list = doc.defaults[g];
		if (!Array.isArray(list)) shape(`defaults.${g} is required`);
		const seen = new Set();
		for (const s of list) {
			if (typeof s !== "string") shape(`defaults.${g} must hold strings`);
			if (seen.has(s)) shape(`defaults.${g} repeats "${s}"`);
			seen.add(s);
			if (
				s !== "*" &&
				s !== "access:read" &&
				s !== "access:write" &&
				!AREA_SELECTOR.test(s) &&
				!PERMISSION_ID.test(s)
			) {
				shape(`defaults.${g} has an invalid entry "${s}"`);
			}
		}
	}
	const owner = doc.defaults.owner;
	if (owner.length !== 1 || owner[0] !== "*") shape('defaults.owner must be ["*"]');
	return doc;
}

/**
 * Validates a manifest document for `app` and expands its defaults; throws ManifestError.
 * @returns {{app: string, version: number, permissions: Map<string, object>, defaultGrants: Record<string, Set<string>>}}
 */
export function checkManifest(input, app = "fingers") {
	const doc = checkShape(input);
	if (doc.app !== app) throw new ManifestError("wrong_app", `the manifest is ${doc.app}'s, not ${app}'s`);
	const areas = new Set();
	for (const a of doc.areas) {
		if (areas.has(a.id)) throw new ManifestError("duplicate_area", `area "${a.id}" is listed twice`);
		areas.add(a.id);
	}
	const permissions = new Map();
	for (const p of doc.permissions) {
		if (permissions.has(p.id))
			throw new ManifestError("duplicate_permission", `permission "${p.id}" is listed twice`);
		if (!areas.has(p.area))
			throw new ManifestError("unknown_area", `permission "${p.id}" names unknown area "${p.area}"`);
		permissions.set(p.id, p);
	}
	const expand = (group, selectors) => {
		const out = new Set();
		for (const s of selectors) {
			if (s === "*") for (const id of permissions.keys()) out.add(id);
			else if (s === "access:read" || s === "access:write") {
				const access = s.slice("access:".length);
				for (const [id, p] of permissions) if (p.access === access) out.add(id);
			} else if (AREA_SELECTOR.test(s)) {
				const area = s.slice("area:".length);
				if (!areas.has(area))
					throw new ManifestError("unknown_area", `defaults.${group} names unknown area "${area}"`);
				for (const [id, p] of permissions) if (p.area === area) out.add(id);
			} else {
				if (!permissions.has(s)) {
					throw new ManifestError("unknown_permission", `defaults.${group} names unknown permission "${s}"`);
				}
				out.add(s);
			}
		}
		return out;
	};
	const defaultGrants = Object.fromEntries(DEFAULT_GROUPS.map((g) => [g, expand(g, doc.defaults[g])]));
	return { app: doc.app, version: doc.version, permissions, defaultGrants };
}

/** Reads manifest/fingers.json (or `path`). */
export function readManifest(path = MANIFEST_PATH) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new ManifestError("invalid_shape", `cannot read ${path}: ${err.message}`);
	}
}

// ---------------------------------------------------------------------------------------------
// Instance identity and the signed registration.

export class ConfigError extends Error {
	name = "ConfigError";
}

/** RFC 7638 thumbprint of an OKP public key (RFC 8037 section 2), base64url. */
export function jwkThumbprint(jwk) {
	const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
	return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

function checkKey(key, where) {
	if (
		!isObj(key) ||
		key.kty !== "OKP" ||
		key.crv !== "Ed25519" ||
		typeof key.d !== "string" ||
		typeof key.x !== "string"
	) {
		throw new ConfigError(`${where} must be an Ed25519 private JWK`);
	}
	try {
		createPrivateKey({ key, format: "jwk" });
	} catch {
		throw new ConfigError(`${where} must be an Ed25519 private JWK`);
	}
	return key;
}

/**
 * The Fingers instance Connect knows: from `file` (Connect's dev seed format
 * {app, instanceId, signingKey}) or from VEYRA_INSTANCE_ID + VEYRA_INSTANCE_KEY.
 * Errors never quote the key.
 */
export function loadInstance({ env = process.env, file } = {}) {
	let id;
	let key;
	if (file) {
		let doc;
		try {
			doc = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			throw new ConfigError(`cannot read the instance file ${file}`);
		}
		if (!isObj(doc) || doc.app !== "fingers")
			throw new ConfigError(`the instance file ${file} is not a fingers instance`);
		id = doc.instanceId;
		key = checkKey(doc.signingKey, `signingKey in ${file}`);
	} else {
		id = env.VEYRA_INSTANCE_ID || undefined;
		const raw = env.VEYRA_INSTANCE_KEY || undefined;
		if (id === undefined && raw === undefined) {
			throw new ConfigError("set VEYRA_INSTANCE_ID and VEYRA_INSTANCE_KEY, or pass --instance-file");
		}
		if (id === undefined) throw new ConfigError("VEYRA_INSTANCE_ID is required with VEYRA_INSTANCE_KEY");
		if (raw === undefined) throw new ConfigError("VEYRA_INSTANCE_KEY is required with VEYRA_INSTANCE_ID");
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new ConfigError("VEYRA_INSTANCE_KEY must be an Ed25519 private JWK");
		}
		key = checkKey(parsed, "VEYRA_INSTANCE_KEY");
	}
	if (typeof id !== "string" || !INSTANCE_ID.test(id)) throw new ConfigError("the instance id must look like inst_…");
	return { id, key };
}

/** AppRegistration for Fingers (Connect's OpenAPI): no meters, no notification kinds. */
export function buildRegistration(instanceId, manifest, nowMs) {
	const iat = Math.floor(nowMs / 1000);
	return {
		iss: instanceId,
		aud: "connect",
		app: "fingers",
		jti: randomBytes(16).toString("base64url"),
		iat,
		exp: iat + LIFETIME_S,
		manifest,
		meters: [],
		notification_kinds: [],
	};
}

/** Compact JWS (EdDSA) over the registration with the instance's Ed25519 key. */
export function signRegistration(instance, payload) {
	const header = { alg: "EdDSA", typ: REGISTRATION_TYP, kid: instance.key.kid ?? jwkThumbprint(instance.key) };
	const input = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
	const signature = sign(null, Buffer.from(input), createPrivateKey({ key: instance.key, format: "jwk" }));
	return `${input}.${signature.toString("base64url")}`;
}

// ---------------------------------------------------------------------------------------------
// Registration.

export class RegistrationError extends Error {
	constructor(message, status, code) {
		super(message);
		this.name = "RegistrationError";
		this.status = status;
		this.code = code;
	}
}

const retryable = (status) => status === 429 || status >= 500;
const hex = (bytes) => randomBytes(bytes).toString("hex");

/**
 * Registers the manifest with Connect; resolves "registered" (201) or "unchanged" (200), throws
 * RegistrationError on a refusal or when it gives up, ManifestError before sending a bad manifest.
 * One X-Request-Id and one trace for the whole registration; every attempt is a new child span.
 */
export async function registerManifest(opts) {
	const doFetch = opts.fetch ?? fetch;
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	const maxAttempts = opts.maxAttempts ?? Number.POSITIVE_INFINITY;
	const { logger, instance, manifest } = opts;
	const { version } = checkManifest(manifest, "fingers");
	const url = `${opts.connectUrl.replace(/\/+$/, "")}/v1/permission-manifests`;
	const requestId = opts.requestId ?? `reg_${hex(12)}`;
	const traceId = hex(16);
	const base = { manifest_version: version, request_id: requestId, trace_id: traceId, instance_id: instance.id };

	for (let attempt = 1; ; attempt++) {
		const spanId = hex(8);
		let status = null;
		let code = null;
		let failure;
		try {
			const res = await doFetch(url, {
				method: "POST",
				headers: {
					"content-type": "application/jwt",
					accept: "application/json",
					"x-request-id": requestId,
					traceparent: `00-${traceId}-${spanId}-01`,
				},
				body: signRegistration(instance, buildRegistration(instance.id, manifest, now())),
				redirect: "manual",
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			status = res.status;
			if (res.status === 200 || res.status === 201) {
				const outcome = res.status === 201 ? "registered" : "unchanged";
				logger.info({ ...base, span_id: spanId, outcome, attempt, http_status: res.status }, "manifest registered");
				return outcome;
			}
			const body = await res.json().catch(() => null);
			code = typeof body?.code === "string" ? body.code : null;
			if (!retryable(res.status)) {
				const detail = typeof body?.detail === "string" ? body.detail.slice(0, 200) : "";
				logger.error(
					{ ...base, span_id: spanId, attempt, http_status: res.status, code },
					"manifest registration refused",
				);
				throw new RegistrationError(
					`Connect refused the manifest (${res.status}${code ? ` ${code}` : ""})${detail ? `: ${detail}` : ""}`,
					res.status,
					code,
				);
			}
		} catch (err) {
			if (err instanceof RegistrationError) throw err;
			failure = err;
		}
		if (attempt >= maxAttempts) {
			logger.error(
				{ ...base, span_id: spanId, attempt, http_status: status, code },
				"manifest registration gave up",
			);
			throw new RegistrationError(`manifest registration gave up after ${attempt} attempts`, status, code);
		}
		const wait = Math.min(BACKOFF_START_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
		const fields = { ...base, span_id: spanId, attempt, retry_in_ms: wait };
		if (status !== null) fields.http_status = status;
		if (code) fields.code = code;
		if (failure) fields.err = { type: failure.name, message: String(failure.message).slice(0, 200) };
		logger.warn(fields, "manifest registration failed, retrying");
		await sleep(wait);
	}
}

// ---------------------------------------------------------------------------------------------
// CLI.

/** JSON lines on stdout with the platform's log fields (contracts/v1/logging.md). */
export function jsonLogger(env = process.env, write = (line) => process.stdout.write(line)) {
	let version = "0.0.0";
	try {
		version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
	} catch {}
	const common = { service: "fingers", version, env: env.VEYRA_ENV || "local" };
	const at = (level) => (fields, msg) =>
		write(`${JSON.stringify({ time: new Date().toISOString(), level, msg, ...common, ...fields })}\n`);
	return { info: at("info"), warn: at("warn"), error: at("error") };
}

const USAGE = `usage: register-manifest.mjs [--check] [--connect-url URL] [--instance-file FILE] [--max-attempts N]
  --check           validate manifest/fingers.json and send nothing
  --connect-url     Connect's internal listener (or VEYRA_CONNECT_INTERNAL_URL)
  --instance-file   the instance JSON Connect's dev seed writes (or VEYRA_INSTANCE_ID + VEYRA_INSTANCE_KEY)
  --max-attempts    give up after N attempts (default: keep retrying)
`;

function parseArgs(argv) {
	const out = { check: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => {
			const v = argv[++i];
			if (v === undefined || v.startsWith("--")) throw new ConfigError(`${arg} needs a value`);
			return v;
		};
		if (arg === "--check") out.check = true;
		else if (arg === "--connect-url") out.connectUrl = value();
		else if (arg === "--instance-file") out.instanceFile = resolve(value());
		else if (arg === "--max-attempts") {
			const n = Number(value());
			if (!Number.isInteger(n) || n < 1) throw new ConfigError("--max-attempts must be a positive integer");
			out.maxAttempts = n;
		} else throw new ConfigError(`unknown argument ${arg}`);
	}
	return out;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
	const logger = jsonLogger(env);
	let args;
	let instance;
	let connectUrl;
	try {
		args = parseArgs(argv);
		if (!args.check) {
			connectUrl = args.connectUrl ?? (env.VEYRA_CONNECT_INTERNAL_URL || undefined);
			if (!connectUrl) throw new ConfigError("set VEYRA_CONNECT_INTERNAL_URL or pass --connect-url");
			if (!/^https?:\/\//.test(connectUrl)) throw new ConfigError("the Connect URL must be http(s)");
			instance = loadInstance({ env, file: args.instanceFile });
		}
	} catch (err) {
		if (!(err instanceof ConfigError)) throw err;
		process.stderr.write(`register-manifest: ${err.message}\n${USAGE}`);
		return 2;
	}
	let manifest;
	try {
		manifest = readManifest();
		const { app, version, permissions } = checkManifest(manifest, "fingers");
		if (args.check) {
			logger.info({ app, manifest_version: version, permissions: permissions.size }, "manifest valid");
			return 0;
		}
	} catch (err) {
		if (!(err instanceof ManifestError)) throw err;
		logger.error({ code: err.code, err: { type: err.name, message: err.message } }, "manifest invalid");
		return 1;
	}
	try {
		await registerManifest({ connectUrl, instance, manifest, logger, maxAttempts: args.maxAttempts });
		return 0;
	} catch (err) {
		if (err instanceof RegistrationError) return 1;
		throw err;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(err) => {
			process.stderr.write(`register-manifest: ${err?.stack ?? err}\n`);
			process.exitCode = 1;
		},
	);
}
