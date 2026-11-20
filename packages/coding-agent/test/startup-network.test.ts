// Fingers starts without calling home: a signed-out start with a local provider sends no request
// anywhere. The upstream code reported installs, fetched model catalogs and checked for updates on
// a hosted service at every start; inside a Hands sandbox that traffic would leave the run.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, VERSION } from "../src/config.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { allowNetwork } from "./test-network-env.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
const tempDirs: string[] = [];

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Preloaded into the child: records every fetch and every TCP connect, and fails fetches so nothing leaves.
const NETWORK_SPY = `
import { appendFileSync } from "node:fs";
import net from "node:net";
const log = process.env.FINGERS_TEST_NETWORK_LOG;
const record = (kind, target) => appendFileSync(log, JSON.stringify({ kind, target }) + "\\n");
globalThis.fetch = async (input) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	record("fetch", url);
	throw new TypeError("fetch failed (blocked by the startup network test)");
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
	const first = Array.isArray(args[0]) ? args[0][0] : args[0];
	if (first && typeof first === "object" && first.path === undefined) {
		record("connect", String(first.host ?? "localhost") + ":" + String(first.port));
	} else if (typeof first === "number") {
		record("connect", String(args[1] ?? "localhost") + ":" + String(first));
	}
	return connect.apply(this, args);
};
`;

function prepare(): { root: string; agentDir: string; projectDir: string; logPath: string; spyUrl: string } {
	const root = mkdtempSync(join(tmpdir(), "fingers-startup-network-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	// A provider defined only in models.json: no sign-in, no Veyra account, no provider key in the environment.
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				local: {
					baseUrl: "http://127.0.0.1:9/v1",
					api: "openai-completions",
					apiKey: "unused",
					models: [{ id: "local-model" }],
				},
			},
		}),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: "local", defaultModel: "local-model" }),
	);
	const spyPath = join(root, "network-spy.mjs");
	writeFileSync(spyPath, NETWORK_SPY);
	return { root, agentDir, projectDir, logPath: join(root, "network.log"), spyUrl: pathToFileURL(spyPath).href };
}

/** Start `fingers --mode rpc`, ask for its state, give background work time to run, and return the requests. */
async function requestsOfRpcStart(options: { providerKey?: Record<string, string> } = {}): Promise<string[]> {
	const { root, agentDir, projectDir, logPath, spyUrl } = prepare();
	if (options.providerKey) {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-5" }),
		);
	}
	const child = spawn(
		process.execPath,
		["--import", sourceResolverUrl, "--import", spyUrl, cliPath, "--mode", "rpc", "--no-session"],
		{
			cwd: projectDir,
			// A clean environment: no FINGERS_OFFLINE, no provider keys, a fresh HOME.
			env: {
				PATH: process.env.PATH ?? "",
				HOME: root,
				USERPROFILE: root,
				TMPDIR: tmpdir(),
				[ENV_AGENT_DIR]: agentDir,
				FINGERS_TEST_NETWORK_LOG: logPath,
				...options.providerKey,
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const exited = new Promise<void>((resolveExit, reject) => {
		child.on("error", reject);
		child.on("close", () => resolveExit());
	});
	await new Promise<void>((resolveState, reject) => {
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			if (stdout.includes('"command":"get_state"')) resolveState();
		});
		child.on("close", () => reject(new Error(`RPC process exited early. stderr:\n${stderr}`)));
		child.stdin.write(`${JSON.stringify({ id: "1", type: "get_state" })}\n`);
	});
	// Catalog refreshes and update checks start in the background right after startup.
	await new Promise((resolveWait) => setTimeout(resolveWait, 2_500));
	child.stdin.end();
	await exited;
	if (!existsSync(logPath)) return [];
	return readFileSync(logPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const { kind, target } = JSON.parse(line) as { kind: string; target: string };
			return `${kind} ${target}`;
		});
}

describe("startup network traffic", () => {
	it("a signed-out RPC start with a local provider makes no network request", async () => {
		expect(await requestsOfRpcStart()).toEqual([]);
	}, 60_000);

	it("a signed-out RPC start with a provider API key fetches no model catalog from a hosted service", async () => {
		expect(await requestsOfRpcStart({ providerKey: { ANTHROPIC_API_KEY: "sk-ant-test" } })).toEqual([]);
	}, 60_000);

	it("the first interactive start records the version without reporting the install", () => {
		allowNetwork();
		vi.stubEnv("FINGERS_TELEMETRY", "1");
		const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);
		let recorded: string | undefined;
		const mode = Object.create(InteractiveMode.prototype, {
			session: { value: { state: { messages: [] } } },
			settingsManager: {
				value: {
					getLastChangelogVersion: () => undefined,
					setLastChangelogVersion: (version: string) => {
						recorded = version;
					},
					getEnableInstallTelemetry: () => true,
				},
			},
		});
		const getChangelogForDisplay = Reflect.get(InteractiveMode.prototype, "getChangelogForDisplay") as (
			this: unknown,
		) => string | undefined;

		expect(getChangelogForDisplay.call(mode)).toBeUndefined();
		expect(recorded).toBeDefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fingers --version prints the Fingers version without a network request", () => {
		const { root, agentDir, logPath, spyUrl } = prepare();
		const result = spawnSync(
			process.execPath,
			["--import", sourceResolverUrl, "--import", spyUrl, cliPath, "--version"],
			{
				encoding: "utf8",
				env: {
					PATH: process.env.PATH ?? "",
					HOME: root,
					USERPROFILE: root,
					[ENV_AGENT_DIR]: agentDir,
					FINGERS_TEST_NETWORK_LOG: logPath,
				},
			},
		);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(VERSION);
		expect(JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8")).version).toBe(VERSION);
		expect(existsSync(logPath)).toBe(false);
	}, 60_000);
});
