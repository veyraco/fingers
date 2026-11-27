/**
 * A Fingers session in a Hands Sandbox (`fingers --hands`), against a fake Hands runs API (hands.yaml) and a
 * fake Brain space lookup.
 *
 * - End to end: the workspace goes up, the run is created with the organization's model connection, Eyes on and the
 *   repository's Brain space, its events are printed, the changes come back, and the session ends with the run (Hands
 *   destroys the sandbox at the end; a stop cancels the run).
 * - Brain refused by Hands (until hands H25): the run goes ahead without memory and says so.
 * - Steering, approvals, stream reconnects, follow-ups (fork of the latest checkpoint), conflicts and path checks.
 * - Local mode is unchanged: without --hands and without the setting nothing of this runs.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import type { HandsRunEvent } from "../src/core/veyra/hands-client.ts";
import { planWorkspace } from "../src/core/veyra/hands-workspace.ts";
import { classifyModelConnections, parseModelConnections } from "../src/core/veyra/model-connections.ts";
import type { VeyraOrganization } from "../src/core/veyra/veyra-auth.ts";
import { chooseModel, LineQueue, runHandsSession } from "../src/modes/hands/hands-session.ts";
import { handsArgsProblem, handsByDefault } from "../src/modes/hands/index.ts";

type Rec = Record<string, any>;

interface Recorded {
	method: string;
	path: string;
	search: string;
	headers: IncomingMessage["headers"];
	json?: Rec;
	form?: { path: string; bytes: string };
}

interface StreamControl {
	runId: string;
	after: number;
	lastEventId?: string;
	send(event: Partial<HandsRunEvent> & { type: string; seq: number; data?: Rec }): void;
	end(): void;
}

/** A fake Hands: the runs API Fingers uses, with scripted event streams. */
class FakeHands {
	readonly requests: Recorded[] = [];
	readonly uploads = new Map<string, { path: string; bytes: string }>();
	readonly runs = new Map<string, Rec>();
	/** Files of the run's final workspace, per run. */
	readonly results = new Map<string, Array<{ change: Rec; content?: string }>>();
	readonly events = new Map<string, Rec[]>();
	/** Answers `createRun` with this problem (once per entry). */
	createErrors: Array<{ status: number; body: Rec }> = [];
	checkpoints = new Map<string, Rec[]>();
	approvals = new Map<string, Rec>();
	brainSpace: Rec | undefined = { id: "spc_web", subject: { type: "project", id: "github.com/acme/web" } };
	/** Plays one stream request; the default sends the run's script and ends. */
	stream: (control: StreamControl) => void | Promise<void> = (control) => {
		for (const event of this.events.get(control.runId) ?? []) {
			if (event.seq > control.after) control.send(event as never);
		}
		control.end();
	};
	private nextRun = 1;
	private nextFile = 1;
	private server: Server | undefined;
	origin = "";

	async start(): Promise<void> {
		this.server = createServer((req, res) => void this.handle(req, res));
		await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
		this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
	}

	async stop(): Promise<void> {
		this.server?.closeAllConnections();
		await new Promise<void>((resolve) => this.server?.close(() => resolve()));
	}

	/** The run's event script: seqs are numbered from 1. */
	script(runId: string, events: Array<{ type: string; data?: Rec }>): void {
		this.events.set(
			runId,
			events.map((event, index) => ({
				id: `rev_${runId}_${index + 1}`,
				run_id: runId,
				seq: index + 1,
				at: new Date(0).toISOString(),
				data: {},
				...event,
			})),
		);
	}

	finish(runId: string, status: string, extra: Rec = {}): void {
		this.runs.set(runId, { ...this.runs.get(runId), status, ...extra });
	}

	private json(res: ServerResponse, status: number, body: unknown): void {
		res.writeHead(status, { "content-type": status >= 400 ? "application/problem+json" : "application/json" });
		res.end(JSON.stringify(body));
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", this.origin);
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const raw = Buffer.concat(chunks);
		const record: Recorded = {
			method: req.method ?? "",
			path: url.pathname,
			search: url.search,
			headers: req.headers,
		};
		const type = String(req.headers["content-type"] ?? "");
		if (type.startsWith("application/json") && raw.length > 0) record.json = JSON.parse(raw.toString("utf-8"));
		if (type.startsWith("multipart/form-data")) {
			const form = await new Response(raw, { headers: { "content-type": type } }).formData();
			const file = form.get("file") as Blob;
			record.form = {
				path: String(form.get("path")),
				bytes: Buffer.from(await file.arrayBuffer()).toString("utf-8"),
			};
		}
		this.requests.push(record);
		const path = url.pathname;

		if (path.startsWith("/brain/v1/spaces/")) {
			if (!this.brainSpace) return this.json(res, 404, { code: "not_found", title: "Not found", status: 404 });
			return this.json(res, 200, this.brainSpace);
		}
		const m = /^\/hands\/v1(\/.*)$/.exec(path);
		if (!m) return this.json(res, 404, { code: "not_found", title: "Not found", status: 404 });
		const route = m[1]!;
		if (req.method === "POST" && route === "/files") {
			const id = `file_${this.nextFile++}`;
			this.uploads.set(id, record.form!);
			return this.json(res, 201, { id, name: record.form!.path, path: record.form!.path, size_bytes: 1 });
		}
		if (req.method === "POST" && route === "/runs") {
			const error = this.createErrors.shift();
			if (error) return this.json(res, error.status, error.body);
			const id = `run_${this.nextRun++}`;
			const run = { id, status: "queued", attempt: 1, ...record.json };
			this.runs.set(id, run);
			return this.json(res, 201, run);
		}
		let r = /^\/runs\/([^/]+)$/.exec(route);
		if (r && req.method === "GET") {
			const run = this.runs.get(r[1]!);
			return run ? this.json(res, 200, run) : this.json(res, 404, { code: "not_found", title: "x", status: 404 });
		}
		r = /^\/runs\/([^/]+)\/cancel$/.exec(route);
		if (r) return this.json(res, 202, this.runs.get(r[1]!));
		r = /^\/runs\/([^/]+)\/events\/stream$/.exec(route);
		if (r) {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(": ping\n\n");
			let ended = false;
			const control: StreamControl = {
				runId: r[1]!,
				after: Number(url.searchParams.get("after") ?? 0),
				lastEventId: req.headers["last-event-id"] as string | undefined,
				send: (event) => {
					if (!ended) res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
				},
				end: () => {
					if (ended) return;
					ended = true;
					res.end();
				},
			};
			await this.stream(control);
			return;
		}
		r = /^\/runs\/([^/]+)\/events$/.exec(route);
		if (r) {
			const after = Number(url.searchParams.get("after") ?? 0);
			const data = (this.events.get(r[1]!) ?? []).filter((event) => event.seq > after);
			return this.json(res, 200, { data, has_more: false, last_seq: data.at(-1)?.seq ?? after });
		}
		r = /^\/runs\/([^/]+)\/messages$/.exec(route);
		if (r) return this.json(res, 201, { id: "msg_1", run_id: r[1], text: record.json?.text, status: "queued" });
		r = /^\/approvals\/([^/]+)$/.exec(route);
		if (r) return this.json(res, 200, this.approvals.get(r[1]!));
		r = /^\/approvals\/([^/]+)\/decision$/.exec(route);
		if (r) return this.json(res, 200, { ...this.approvals.get(r[1]!), status: record.json?.decision });
		r = /^\/runs\/([^/]+)\/files$/.exec(route);
		if (r) return this.json(res, 200, { base: "x", data: (this.results.get(r[1]!) ?? []).map((f) => f.change) });
		r = /^\/runs\/([^/]+)\/files\/content$/.exec(route);
		if (r) {
			const file = (this.results.get(r[1]!) ?? []).find((f) => f.change.path === url.searchParams.get("path"));
			if (!file) return this.json(res, 404, { code: "not_found", title: "x", status: 404 });
			res.writeHead(200, { "content-type": "application/octet-stream" });
			res.end(file.content ?? "");
			return;
		}
		r = /^\/runs\/([^/]+)\/checkpoints$/.exec(route);
		if (r) return this.json(res, 200, { data: this.checkpoints.get(r[1]!) ?? [] });
		r = /^\/runs\/([^/]+)\/checkpoints\/([^/]+)\/fork$/.exec(route);
		if (r) {
			const id = `run_${this.nextRun++}`;
			const run = {
				id,
				status: "queued",
				attempt: 1,
				parent: { run_id: r[1], checkpoint_id: r[2] },
				...record.json,
			};
			this.runs.set(id, run);
			return this.json(res, 201, run);
		}
		return this.json(res, 404, { code: "not_found", title: "x", status: 404 });
	}
}

const ORG: VeyraOrganization = {
	id: "org_acme",
	name: "Acme",
	tier: "team",
	appsEnabled: ["fingers", "hands", "brain", "eyes"],
	groupName: "Editor",
};

const CONNECTIONS = {
	data: [
		{
			id: "mc_anthropic",
			provider: "anthropic",
			auth: "api_key",
			name: "Anthropic prod",
			apps: ["fingers", "hands"],
			groups: [],
			capabilities: ["chat"],
			models: ["claude-sonnet-4-5"],
		},
	],
};

function stubAuth(fake: FakeHands, org: VeyraOrganization = ORG, signedIn = true) {
	return {
		account: () =>
			signedIn
				? ({ org: org.id, orgName: org.name, group: "grp_editor", groupName: "Editor", sub: "usr_ada" } as never)
				: undefined,
		apiBaseUrl: (app: string) => `${fake.origin}/${app}/v1`,
		getAccessToken: async (app: string) => `token-for-${app}`,
		organization: async () => org,
		listModelConnections: async () => CONNECTIONS,
	};
}

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf-8",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
	});
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

/** A git repository whose HEAD is on `origin/main` (github.com/acme/web), as after a push. */
function pushedRepo(root: string, files: Record<string, string>): string {
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "--local", "user.email", "ada@example.com");
	git(root, "config", "--local", "user.name", "Ada");
	git(root, "config", "--local", "commit.gpgsign", "false");
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "start");
	git(root, "remote", "add", "origin", "https://github.com/acme/web.git");
	const head = git(root, "rev-parse", "HEAD");
	git(root, "update-ref", "refs/remotes/origin/main", head);
	return head;
}

let hands: FakeHands;
let dir: string;
let output: string[];

const write = (text: string) => {
	output.push(text);
};
const printed = () => output.join("");
const quick = { retryDelayMs: 0, sleep: async () => {}, stopWaitMs: 2_000 };

/** Sends the run's whole script, marks the run `status` and ends the stream. */
function playAll(status = "succeeded", extra: Rec = {}) {
	return (control: StreamControl) => {
		for (const event of hands.events.get(control.runId) ?? []) control.send(event as never);
		hands.finish(control.runId, status, extra);
		control.end();
	};
}

function finishedScript(runId: string, extra: Array<{ type: string; data?: Rec }> = []) {
	hands.script(runId, [
		{ type: "run.created" },
		{ type: "sandbox.ready" },
		{ type: "workspace.ready" },
		...extra,
		{ type: "run.finished", data: { status: "succeeded" } },
	]);
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting; printed:\n${printed()}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

beforeEach(async () => {
	hands = new FakeHands();
	await hands.start();
	dir = mkdtempSync(join(tmpdir(), "fingers-hands-"));
	output = [];
});

afterEach(async () => {
	await hands.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("a Fingers session in a Hands Sandbox", () => {
	it("runs a task end to end: files up, the run with the org's connection and Eyes, events, changes back", async () => {
		writeFileSync(join(dir, "a.txt"), "old a\n");
		writeFileSync(join(dir, "d.txt"), "delete me\n");
		finishedScript("run_1", [
			{ type: "agent.message", data: { text: "I will fix a.txt." } },
			{
				type: "tool_call.started",
				data: { call_id: "c1", server: "fingers", tool: "edit", arguments: { path: "a.txt" } },
			},
			{ type: "tool_call.finished", data: { call_id: "c1", ok: true } },
			{ type: "file.changed", data: { path: "a.txt", change: "modified", additions: 1, deletions: 1 } },
		]);
		hands.stream = playAll("succeeded", {
			usage: {
				duration_seconds: 72,
				input_tokens: 12_300,
				output_tokens: 2_100,
				model_cost: { amount_minor: 4, currency: "USD" },
			},
			eyes_url: "https://eyes.veyra.localhost/traces/abc",
		});
		hands.results.set("run_1", [
			{ change: { path: "a.txt", change: "modified", additions: 1, deletions: 1 }, content: "new a\n" },
			{ change: { path: "b/c.txt", change: "added", additions: 1, deletions: 0 }, content: "added\n" },
			{ change: { path: "d.txt", change: "deleted", additions: 0, deletions: 1 } },
		]);

		const result = await runHandsSession({
			auth: stubAuth(hands),
			cwd: dir,
			prompt: "Fix a.txt",
			output: "text",
			write,
			interactive: false,
			...quick,
		});

		expect(result.exitCode).toBe(0);
		// The workspace went up: each file at its path.
		expect([...hands.uploads.values()].sort((x, y) => x.path.localeCompare(y.path))).toEqual([
			{ path: "a.txt", bytes: "old a\n" },
			{ path: "d.txt", bytes: "delete me\n" },
		]);
		const create = hands.requests.find((r) => r.method === "POST" && r.path === "/hands/v1/runs")!;
		expect(create.json).toMatchObject({
			task: { title: "Fix a.txt", prompt: "Fix a.txt" },
			model: { connection_id: "mc_anthropic", model: "claude-sonnet-4-5" },
			harness: { name: "fingers" },
			workspace: { type: "files", file_ids: expect.arrayContaining(["file_1", "file_2"]) },
			target: { type: "sandbox" },
			observability: { send_to_eyes: true },
		});
		// No git remote, so no repository memory to give.
		expect(create.json!.memory).toBeUndefined();
		expect(create.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
		expect(create.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
		// Every Hands call carries the person's Hands token, and the run names no credential.
		for (const request of hands.requests.filter((r) => r.path.startsWith("/hands/"))) {
			expect(request.headers.authorization).toBe("Bearer token-for-hands");
		}
		expect(JSON.stringify(create.json)).not.toMatch(/api_key|secret|token/i);
		// The changes came back.
		expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("new a\n");
		expect(readFileSync(join(dir, "b/c.txt"), "utf-8")).toBe("added\n");
		expect(existsSync(join(dir, "d.txt"))).toBe(false);
		// What the person saw.
		const text = printed();
		expect(text).toContain("Hands · Acme · Anthropic prod · claude-sonnet-4-5");
		expect(text).toContain("memory: off (this directory has no git remote to name its memory)");
		expect(text).toContain("Sandbox ready");
		expect(text).toContain("I will fix a.txt.");
		expect(text).toContain("› edit path=a.txt");
		expect(text).toContain("  ~ a.txt +1 −1");
		expect(text).toContain("Run succeeded · 1m 12s · 12.3k in / 2.1k out · $0.04");
		expect(text).toContain("✓ 3 files from Hands: a.txt, b/c.txt, d.txt");
		expect(text).toContain("Eyes: https://eyes.veyra.localhost/traces/abc");
		// The session ended with the run: no cancel was needed, Hands destroys the sandbox at the end.
		expect(hands.requests.some((r) => r.path.endsWith("/cancel"))).toBe(false);
	});

	it("clones a pushed repository with the local changes as overlay, and gives the run the repository's Brain space", async () => {
		const head = pushedRepo(dir, { "src/a.ts": "a\n", "README.md": "web\n" });
		writeFileSync(join(dir, "src/a.ts"), "a changed\n");
		writeFileSync(join(dir, "notes.md"), "untracked\n");
		writeFileSync(join(dir, ".gitignore"), "dist/\n");
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist/out.js"), "ignored\n");
		finishedScript("run_1");
		hands.stream = playAll();

		const result = await runHandsSession({
			auth: stubAuth(hands),
			cwd: join(dir, "src"),
			prompt: "Tidy",
			output: "text",
			write,
			interactive: false,
			...quick,
		});

		expect(result.exitCode).toBe(0);
		const create = hands.requests.find((r) => r.method === "POST" && r.path === "/hands/v1/runs")!;
		expect(create.json!.workspace).toEqual({ type: "git", repo: "acme/web", ref: head, file_ids: expect.any(Array) });
		expect([...hands.uploads.values()].map((u) => u.path).sort()).toEqual([".gitignore", "notes.md", "src/a.ts"]);
		expect(create.json!.memory).toEqual({ brain_space_id: "spc_web", learn: true });
		const brain = hands.requests.find((r) => r.path.startsWith("/brain/"))!;
		expect(decodeURIComponent(brain.path)).toBe("/brain/v1/spaces/subject:project:github.com/acme/web");
		expect(brain.headers.authorization).toBe("Bearer token-for-brain");
		expect(printed()).toContain(`workspace: git acme/web @ ${head.slice(0, 7)} + 3 changed files`);
		expect(printed()).toContain("memory: Brain web");
	});

	it("goes ahead without memory when Hands refuses it (Brain memory for runs comes with hands H25)", async () => {
		pushedRepo(dir, { "a.txt": "a\n" });
		hands.createErrors.push({
			status: 400,
			body: {
				code: "invalid_request",
				title: "Invalid request",
				status: 400,
				errors: [{ field: "memory.brain_space_id", message: "Brain memory isn't available for runs yet." }],
			},
		});
		finishedScript("run_1");
		hands.stream = playAll();

		const result = await runHandsSession({
			auth: stubAuth(hands),
			cwd: dir,
			prompt: "Go",
			output: "text",
			write,
			interactive: false,
			...quick,
		});

		expect(result.exitCode).toBe(0);
		const creates = hands.requests.filter((r) => r.method === "POST" && r.path === "/hands/v1/runs");
		expect(creates).toHaveLength(2);
		expect(creates[0]!.json!.memory).toEqual({ brain_space_id: "spc_web", learn: true });
		expect(creates[1]!.json!.memory).toBeUndefined();
		expect(creates[0]!.headers["idempotency-key"]).not.toBe(creates[1]!.headers["idempotency-key"]);
		expect(printed()).toContain("memory: off (Hands: Brain memory isn't available for runs yet.)");
	});

	it("refuses a workspace Hands can't take, before anything is uploaded", async () => {
		pushedRepo(dir, { "a.txt": "a\n", "gone.txt": "x\n" });
		rmSync(join(dir, "gone.txt"));
		let result = await runHandsSession({
			auth: stubAuth(hands),
			cwd: dir,
			prompt: "Go",
			output: "text",
			write,
			interactive: false,
			...quick,
		});
		expect(result.exitCode).toBe(1);
		expect(printed()).toContain("can't take a deleted file (gone.txt)");

		const big = mkdtempSync(join(tmpdir(), "fingers-hands-big-"));
		try {
			for (let i = 0; i < 101; i++) writeFileSync(join(big, `f${i}.txt`), "x");
			output = [];
			result = await runHandsSession({
				auth: stubAuth(hands),
				cwd: big,
				prompt: "Go",
				output: "text",
				write,
				interactive: false,
				...quick,
			});
			expect(result.exitCode).toBe(1);
			expect(printed()).toContain("Hands takes at most 100 files without a pushed commit");
		} finally {
			rmSync(big, { recursive: true, force: true });
		}
		expect(hands.requests.filter((r) => r.path.startsWith("/hands/"))).toEqual([]);
	});

	it("says so when Hands is off, nobody is signed in, or the group may not start runs", async () => {
		let result = await runHandsSession({
			auth: stubAuth(hands, { ...ORG, appsEnabled: ["fingers"] }),
			cwd: dir,
			prompt: "Go",
			output: "text",
			write,
			interactive: false,
		});
		expect(result.exitCode).toBe(1);
		expect(printed()).toContain("Hands is off in Acme");

		output = [];
		result = await runHandsSession({
			auth: stubAuth(hands, ORG, false),
			cwd: dir,
			prompt: "Go",
			output: "text",
			write,
			interactive: false,
		});
		expect(result.exitCode).toBe(1);
		expect(printed()).toContain("Not signed in to Veyra. Run fingers login.");
		expect(hands.requests.filter((r) => r.path.startsWith("/hands/"))).toEqual([]);

		output = [];
		hands.createErrors.push({
			status: 403,
			body: { code: "permission_denied", title: "Forbidden", status: 403, permission: "runs:write" },
		});
		result = await runHandsSession({
			auth: stubAuth(hands),
			cwd: dir,
			prompt: "Go",
			output: "text",
			write,
			interactive: false,
			...quick,
		});
		expect(result.exitCode).toBe(1);
		expect(printed()).toContain("Your group may not do this in Hands (runs:write)");
	});

	it("keeps a file the person changed while the run worked, and saves the run's version beside it", async () => {
		writeFileSync(join(dir, "a.txt"), "start\n");
		finishedScript("run_1");
		const play = playAll();
		hands.stream = (control) => {
			// The person edits a.txt while the agent works.
			writeFileSync(join(dir, "a.txt"), "mine, longer\n");
			play(control);
		};
		hands.results.set("run_1", [
			{ change: { path: "a.txt", change: "modified", additions: 1, deletions: 1 }, content: "theirs\n" },
		]);

		await runHandsSession({
			auth: stubAuth(hands),
			cwd: dir,
			prompt: "Go",
			output: "text",
			write,
			interactive: false,
			...quick,
		});

		expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("mine, longer\n");
		expect(readFileSync(join(dir, ".fingers/hands/run_1/a.txt"), "utf-8")).toBe("theirs\n");
		expect(printed()).toContain("! kept your change to a.txt; the run's version is in .fingers/hands/run_1/a.txt");
	});

	it("never writes outside the workspace, into .git or through a symbolic link", async () => {
		const outside = mkdtempSync(join(tmpdir(), "fingers-hands-outside-"));
		// A name of this test's own, next to the workspace, so no other run's leftovers count.
		const escapeName = `${basename(dir)}-evil.txt`;
		try {
			writeFileSync(join(dir, "a.txt"), "a\n");
			symlinkSync(outside, join(dir, "link"));
			finishedScript("run_1");
			hands.stream = playAll();
			hands.results.set("run_1", [
				{ change: { path: `../${escapeName}`, change: "added", additions: 1, deletions: 0 }, content: "x" },
				{ change: { path: ".git/config", change: "added", additions: 1, deletions: 0 }, content: "x" },
				{ change: { path: "link/evil.txt", change: "added", additions: 1, deletions: 0 }, content: "x" },
				{ change: { path: "/etc/evil", change: "added", additions: 1, deletions: 0 }, content: "x" },
			]);

			await runHandsSession({
				auth: stubAuth(hands),
				cwd: dir,
				prompt: "Go",
				output: "text",
				write,
				interactive: false,
				...quick,
			});

			expect(existsSync(join(dir, "..", escapeName))).toBe(false);
			expect(existsSync(join(outside, "evil.txt"))).toBe(false);
			expect(existsSync(join(dir, ".git"))).toBe(false);
			expect(printed()).toContain(`! not written (outside the workspace): ../${escapeName}`);
			expect(printed()).toContain("! not written (outside the workspace): link/evil.txt");
			expect(hands.requests.some((r) => r.path.endsWith("/files/content"))).toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
			rmSync(join(dir, "..", escapeName), { force: true });
		}
	});

	it("Ctrl-C cancels the run, the changes still come back, and the exit code is 130", async () => {
		writeFileSync(join(dir, "a.txt"), "a\n");
		let interrupt: () => void = () => {};
		hands.runs.set("run_1", { id: "run_1", status: "running" });
		hands.stream = (control) => {
			hands.finish("run_1", "running");
			control.send({ id: "e1", run_id: "run_1", seq: 1, at: "", type: "agent.message", data: { text: "working" } });
			// The person presses Ctrl-C while the run works; Hands then ends it as cancelled.
			setTimeout(() => {
				interrupt();
				setTimeout(() => {
					hands.finish("run_1", "cancelled", {
						failure: { code: "cancelled_by_actor", message: "Stopped in Fingers" },
					});
					control.send({
						id: "e2",
						run_id: "run_1",
						seq: 2,
						at: "",
						type: "run.finished",
						data: { status: "cancelled" },
					});
					control.end();
				}, 50);
			}, 20);
		};
		hands.results.set("run_1", [
			{ change: { path: "a.txt", change: "modified", additions: 1, deletions: 1 }, content: "partial\n" },
		]);

		const result = await runHandsSession({
			auth: stubAuth(hands),
			cwd: dir,
			prompt: "Go",
			output: "text",
			write,
			interactive: false,
			onInterrupt: (handler) => {
				interrupt = handler;
				return () => {};
			},
			...quick,
		});

		expect(result.exitCode).toBe(130);
		const cancel = hands.requests.find((r) => r.path === "/hands/v1/runs/run_1/cancel")!;
		expect(cancel.json).toEqual({ reason: "Stopped in Fingers" });
		expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("partial\n");
		expect(printed()).toContain("Stopping the run…");
		expect(printed()).toContain("Run cancelled");
	});

	it("a second Ctrl-C leaves at once, without waiting for Hands", async () => {
		let interrupt: () => void = () => {};
		hands.stream = (control) => {
			hands.finish("run_1", "running");
			control.send({ id: "e1", run_id: "run_1", seq: 1, at: "", type: "agent.message", data: { text: "working" } });
			setTimeout(() => {
				interrupt();
				interrupt();
			}, 20);
			// Hands never ends this stream.
		};
		const result = await runHandsSession({
			auth: stubAuth(hands),
			cwd: dir,
			prompt: "Go",
			output: "text",
			write,
			interactive: false,
			onInterrupt: (handler) => {
				interrupt = handler;
				return () => {};
			},
			...quick,
		});
		expect(result.exitCode).toBe(130);
		// The cancel reached Hands before Fingers left, so the sandbox goes away; nothing was pulled back.
		expect(hands.requests.some((r) => r.path === "/hands/v1/runs/run_1/cancel")).toBe(true);
		expect(hands.requests.some((r) => r.path.endsWith("/files"))).toBe(false);
	});

	it("in a terminal, a typed line steers the run and answers its approval", async () => {
		const input = new LineQueue();
		hands.approvals.set("apr_1", {
			id: "apr_1",
			run_id: "run_1",
			status: "pending",
			tool: { server: "fingers", name: "bash", arguments: { command: "npm test" } },
		});
		hands.stream = async (control) => {
			hands.finish("run_1", "needs_approval");
			control.send({
				id: "e1",
				run_id: "run_1",
				seq: 1,
				at: "",
				type: "approval.requested",
				data: { approval_id: "apr_1" },
			});
			await until(() => printed().includes("waits for your approval"));
			input.push("y");
			await until(() => hands.requests.some((r) => r.path === "/hands/v1/approvals/apr_1/decision"));
			control.send({
				id: "e2",
				run_id: "run_1",
				seq: 2,
				at: "",
				type: "approval.resolved",
				data: { approval_id: "apr_1", decision: "approve" },
			});
			input.push("also add a test");
			await until(() => hands.requests.some((r) => r.path === "/hands/v1/runs/run_1/messages"));
			hands.finish("run_1", "succeeded");
			control.send({
				id: "e3",
				run_id: "run_1",
				seq: 3,
				at: "",
				type: "run.finished",
				data: { status: "succeeded" },
			});
			control.end();
			await until(() => printed().includes("Next message"));
			input.push("");
		};

		const result = await runHandsSession({
			auth: stubAuth(hands),
			cwd: dir,
			prompt: "Go",
			output: "text",
			write,
			interactive: true,
			input,
			...quick,
		});

		expect(result.exitCode).toBe(0);
		expect(hands.requests.find((r) => r.path === "/hands/v1/approvals/apr_1/decision")!.json).toEqual({
			decision: "approve",
		});
		expect(hands.requests.find((r) => r.path === "/hands/v1/runs/run_1/messages")!.json).toEqual({
			text: "also add a test",
		});
		expect(printed()).toContain("? fingers.bash command=npm test waits for your approval");
		expect(printed()).toContain("  approval approve");
		expect(printed()).toContain("  → sent to the agent");
	});

	it("follows the run again after the stream drops, from the last event, without printing anything twice", async () => {
		hands.script("run_1", [
			{ type: "agent.message", data: { text: "first" } },
			{ type: "agent.message", data: { text: "second" } },
			{ type: "agent.message", data: { text: "third" } },
			{ type: "run.finished", data: { status: "succeeded" } },
		]);
		const all = hands.events.get("run_1")!;
		const streams: StreamControl[] = [];
		hands.stream = (control) => {
			streams.push(control);
			if (streams.length === 1) {
				// The connection drops after two events, while the run still works (the replay has nothing newer yet).
				hands.finish("run_1", "running");
				hands.events.set("run_1", all.slice(0, 2));
				control.send(all[0] as never);
				control.send(all[1] as never);
				control.end();
				return;
			}
			hands.events.set("run_1", all);
			hands.finish("run_1", "succeeded");
			for (const event of all) if (event.seq > control.after) control.send(event as never);
			control.end();
		};

		const result = await runHandsSession({
			auth: stubAuth(hands),
			cwd: dir,
			prompt: "Go",
			output: "text",
			write,
			interactive: false,
			...quick,
		});

		expect(result.exitCode).toBe(0);
		expect(streams).toHaveLength(2);
		expect(streams[1]!.after).toBe(2);
		expect(streams[1]!.lastEventId).toBe("2");
		const text = printed();
		expect(text.match(/first/g)).toHaveLength(1);
		expect(text.match(/second/g)).toHaveLength(1);
		expect(text.match(/third/g)).toHaveLength(1);
	});

	it("a next message forks the run's latest checkpoint; after local edits it starts a fresh run", async () => {
		writeFileSync(join(dir, "a.txt"), "a\n");
		const input = new LineQueue();
		hands.stream = (control) => {
			hands.finish(control.runId, "succeeded");
			control.send({
				id: "e",
				run_id: control.runId,
				seq: 1,
				at: "",
				type: "run.finished",
				data: { status: "succeeded" },
			});
			control.end();
		};
		hands.checkpoints.set("run_1", [
			{ id: "cp_1", run_id: "run_1", label: "a", created_at: "" },
			{ id: "cp_2", run_id: "run_1", label: "end", created_at: "" },
		]);
		hands.checkpoints.set("run_2", [{ id: "cp_9", run_id: "run_2", label: "end", created_at: "" }]);
		const session = runHandsSession({
			auth: stubAuth(hands),
			cwd: dir,
			prompt: "Go",
			output: "text",
			write,
			interactive: true,
			input,
			...quick,
		});
		// A line typed while a run works steers it; this one comes after the run, so it continues the session.
		await until(() => printed().split("Next message").length === 2);
		input.push("now add docs");
		await until(() => printed().split("Next message").length === 3);
		// The person edits a file before the third message: Fingers can't fork, so it starts fresh with the new files.
		writeFileSync(join(dir, "a.txt"), "edited locally\n");
		input.push("and a changelog");
		await until(() => printed().split("Next message").length === 4);
		input.push("");
		const result = await session;

		expect(result.exitCode).toBe(0);
		const fork = hands.requests.find((r) => r.path === "/hands/v1/runs/run_1/checkpoints/cp_2/fork")!;
		expect(fork.json).toEqual({ message: "now add docs" });
		const creates = hands.requests.filter((r) => r.method === "POST" && r.path === "/hands/v1/runs");
		expect(creates).toHaveLength(2);
		expect(creates[1]!.json!.task.prompt).toBe("and a changelog");
		expect([...hands.uploads.values()].at(-1)).toEqual({ path: "a.txt", bytes: "edited locally\n" });
		expect(printed()).toContain("Run run_2 continues from cp_2");
		expect(printed()).toContain("Your files changed since the last run, so this starts a fresh run with them.");
	});

	it("prints each run event as one JSON line in --mode json", async () => {
		finishedScript("run_1", [{ type: "agent.message", data: { text: "hi" } }]);
		hands.stream = playAll();
		const result = await runHandsSession({
			auth: stubAuth(hands),
			cwd: dir,
			prompt: "Go",
			output: "json",
			write,
			interactive: false,
			...quick,
		});
		expect(result.exitCode).toBe(0);
		const lines = printed()
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines.map((line) => line.type)).toEqual([
			"run.created",
			"sandbox.ready",
			"workspace.ready",
			"agent.message",
			"run.finished",
			"fingers.hands.summary",
		]);
		expect(lines.at(-1)).toMatchObject({ run_id: "run_1", status: "succeeded" });
	});
});

describe("the model of a Hands run", () => {
	const offered = classifyModelConnections(
		parseModelConnections({
			data: [
				{ ...CONNECTIONS.data[0] },
				{
					id: "mc_openai",
					provider: "openai",
					name: "OpenAI",
					apps: ["fingers", "hands"],
					groups: [],
					capabilities: [],
					models: [],
				},
			],
		}),
		{ group: "grp_editor" },
	).offered;

	it("takes --model veyra-<connection>/<model>, the Veyra default provider, or the first connection's first model", () => {
		expect(chooseModel(offered, { model: "veyra-mc_openai/gpt-5" })).toMatchObject({
			model: "gpt-5",
			connection: { providerId: "veyra-mc_openai" },
		});
		expect(chooseModel(offered, { provider: "veyra-mc_openai", model: "gpt-5" }).model).toBe("gpt-5");
		expect(chooseModel(offered, { defaultProvider: "veyra-mc_openai", defaultModel: "gpt-4.1" }).model).toBe(
			"gpt-4.1",
		);
		expect(chooseModel(offered, {})).toMatchObject({
			model: "claude-sonnet-4-5",
			connection: { providerId: "veyra-mc_anthropic" },
		});
		// A default that is not a Veyra connection is not used for Hands.
		expect(chooseModel(offered, { defaultProvider: "anthropic", defaultModel: "claude-opus-4" })).toMatchObject({
			model: "claude-sonnet-4-5",
		});
	});

	it("refuses a provider that is not one of the organization's connections, and a connection without a model", () => {
		expect(() => chooseModel(offered, { provider: "anthropic", model: "x" })).toThrow(
			/is not one\. Pick one of: veyra-mc_anthropic/,
		);
		expect(() => chooseModel(offered, { provider: "veyra-mc_other" })).toThrow(/not one of the model connections/);
		expect(() => chooseModel(offered, { provider: "veyra-mc_openai" })).toThrow(
			/--model veyra-mc_openai\/<model id>/,
		);
	});
});

describe("local mode is unchanged", () => {
	it("starts in Hands only with --hands or the hands.default setting, and never over flags of a local session", () => {
		expect(parseArgs(["fix it"]).hands).toBeUndefined();
		expect(handsByDefault(parseArgs(["fix it"]), undefined)).toBe(false);
		expect(handsByDefault(parseArgs(["fix it"]), false)).toBe(false);
		expect(handsByDefault(parseArgs(["fix it"]), true)).toBe(true);
		expect(handsByDefault(parseArgs(["--local", "fix it"]), true)).toBe(false);
		expect(handsByDefault(parseArgs(["-c"]), true)).toBe(false);
		expect(handsByDefault(parseArgs(["--mode", "rpc"]), true)).toBe(false);
		expect(handsByDefault(parseArgs(["--help"]), true)).toBe(false);
		expect(parseArgs(["--hands", "--hands-size", "large-8", "go"])).toMatchObject({
			hands: true,
			handsSize: "large-8",
			messages: ["go"],
		});
		expect(parseArgs(["--hands-size"]).diagnostics[0]!.message).toContain("--hands-size requires a size");
	});

	it("refuses --hands with arguments that only a local session has", () => {
		expect(handsArgsProblem(parseArgs(["--hands", "go"]))).toBeUndefined();
		expect(handsArgsProblem(parseArgs(["--hands", "--local"]))).toContain("exclude each other");
		expect(handsArgsProblem(parseArgs(["--hands", "--mode", "rpc"]))).toContain("--mode rpc");
		expect(handsArgsProblem(parseArgs(["--hands", "-c"]))).toContain("--continue");
		expect(handsArgsProblem(parseArgs(["--hands", "@a.ts", "go"]))).toContain("@file");
	});

	it("planning a workspace only reads the directory", async () => {
		writeFileSync(join(dir, "a.txt"), "a\n");
		const plan = await planWorkspace(dir);
		expect(plan).toMatchObject({ kind: "files", upload: ["a.txt"] });
		expect(hands.requests).toEqual([]);
	});
});
