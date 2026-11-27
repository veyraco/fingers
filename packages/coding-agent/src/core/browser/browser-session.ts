/**
 * One headless Chromium for the browser tool: started on demand with a fresh profile in a temporary
 * directory, driven over the DevTools pipe, every request sent through the filtering proxy, stopped and
 * its profile deleted on `close()`.
 *
 * Network: `--proxy-server` with `<-loopback>` sends loopback through the proxy too; the host resolver
 * maps every name except the proxy's address to "not found", so nothing the proxy did not vet can be
 * resolved; QUIC is off and WebRTC may not use UDP outside the proxy. Downloads are refused, dialogs
 * dismissed. Pages on a scheme other than http(s) or about: are left without returning their content.
 *
 * The executable comes from FINGERS_BROWSER_PATH or a fixed list of absolute install locations; PATH is
 * never searched, so a program planted in the project cannot stand in for the browser.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { CdpPipe } from "./cdp-pipe.ts";
import { type BlockedRequest, type BrowserLog, FilterProxy } from "./filter-proxy.ts";
import { HostPolicy, type NetworkConfig, normalizeHost } from "./host-policy.ts";

type Json = Record<string, any>;

const KNOWN_LOCATIONS: Record<string, string[]> = {
	linux: [
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/google-chrome",
		"/snap/bin/chromium",
		"/opt/google/chrome/chrome",
	],
	darwin: [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
	],
	win32: [
		"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
		"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	],
};

function isExecutable(path: string): boolean {
	try {
		accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * The browser executable: FINGERS_BROWSER_PATH (must exist), else the first known install location.
 * Undefined when there is none.
 */
export function findBrowserExecutable(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	exists: (path: string) => boolean = isExecutable,
): string | undefined {
	const configured = env.FINGERS_BROWSER_PATH?.trim();
	if (configured) return exists(configured) ? configured : undefined;
	return (KNOWN_LOCATIONS[platform] ?? []).find((path) => exists(path));
}

/** The browser command line (without the executable). */
export function browserArguments(input: {
	userDataDir: string;
	proxyUrl: string;
	noSandbox: boolean;
	platform?: NodeJS.Platform;
}): string[] {
	const proxyHost = new URL(input.proxyUrl).hostname;
	const args = [
		"--headless",
		"--remote-debugging-pipe",
		`--user-data-dir=${input.userDataDir}`,
		`--proxy-server=${input.proxyUrl}`,
		"--proxy-bypass-list=<-loopback>",
		`--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE ${proxyHost}`,
		"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
		"--webrtc-ip-handling-policy=disable_non_proxied_udp",
		"--disable-quic",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
		"--disable-component-update",
		"--disable-sync",
		"--disable-default-apps",
		"--disable-extensions",
		"--disable-domain-reliability",
		"--disable-client-side-phishing-detection",
		"--disable-component-extensions-with-background-pages",
		"--disable-field-trial-config",
		"--disable-breakpad",
		"--disable-search-engine-choice-screen",
		"--no-pings",
		"--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,AutofillServerCommunication,CertificateTransparencyComponentUpdater,InterestFeedContentSuggestions",
		"--metrics-recording-only",
		"--password-store=basic",
		"--use-mock-keychain",
		"--mute-audio",
		"--hide-scrollbars",
		"--window-size=1280,800",
	];
	if ((input.platform ?? process.platform) === "linux") args.push("--disable-dev-shm-usage");
	if (input.noSandbox) args.push("--no-sandbox");
	args.push("about:blank");
	return args;
}

export interface BrowserSessionOptions {
	network?: NetworkConfig;
	log?: BrowserLog;
	env?: NodeJS.ProcessEnv;
	/** Page load timeout for `navigate` (default 30 s). */
	navigationTimeoutMs?: number;
	/** How long a starting browser may take to answer (default 60 s). */
	startTimeoutMs?: number;
	/** Characters of page text `text` returns (default 20,000). */
	maxTextChars?: number;
}

interface PageText {
	title: string;
	url: string;
	text: string;
	truncated: boolean;
	links: Array<{ text: string; href: string }>;
}

export interface ActionReport {
	url: string;
	title: string;
	/** Requests the proxy refused during the action. */
	blocked: BlockedRequest[];
}

const SHOWN_SCHEMES = new Set(["http:", "https:", "about:"]);

/**
 * How long a starting browser may take to answer. A first start on a fresh machine or pod (cold disk
 * cache, font cache built on first use) under load can pass 20 s; a CI runner with the test suite
 * running beside it did.
 */
const START_TIMEOUT_MS = 60_000;

/** `host:port` a request URL goes to (http, https, ws, wss), as the proxy names it. */
function requestTarget(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		const defaults: Record<string, number> = { "http:": 80, "ws:": 80, "https:": 443, "wss:": 443 };
		const fallback = defaults[parsed.protocol];
		if (fallback === undefined) return undefined;
		return `${normalizeHost(parsed.hostname)}:${parsed.port ? Number(parsed.port) : fallback}`;
	} catch {
		return undefined;
	}
}

/** Origin of a URL for logs (never path, query or fragment). */
function originOf(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : parsed.protocol;
	} catch {
		return "invalid";
	}
}

const TEXT_SCRIPT = `(() => {
	const links = [...document.querySelectorAll("a[href]")].slice(0, 50).map((a) => ({
		text: (a.innerText || a.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 80),
		href: a.href,
	}));
	return { title: document.title, url: location.href, text: document.body ? document.body.innerText : "", links };
})()`;

export class BrowserSession {
	private readonly options: BrowserSessionOptions;
	private readonly policy: HostPolicy;
	private proxy: FilterProxy | undefined;
	private child: ChildProcess | undefined;
	private cdp: CdpPipe | undefined;
	private sessionId: string | undefined;
	private mainFrameId: string | undefined;
	private userDataDir: string | undefined;
	private starting: Promise<void> | undefined;
	private stderrTail = "";
	/** Chrome's own FATAL and ERROR log lines, kept apart from the tail so a crash dump cannot push them out. */
	private stderrFatal: string | undefined;
	private stderrErrors: string[] = [];
	/** `host:port` of the page's own requests (and WebSockets), with when they started. */
	private pageRequests: Array<{ target: string; at: number }> = [];

	constructor(options: BrowserSessionOptions = {}) {
		this.options = options;
		// Throws on a bad host pattern, so a bad configure fails before any browser starts.
		this.policy = new HostPolicy(options.network);
	}

	get running(): boolean {
		return this.cdp !== undefined && !this.cdp.closed;
	}

	private log(level: "debug" | "info" | "warn", msg: string, fields?: Record<string, unknown>): void {
		this.options.log?.(level, msg, fields);
	}

	/** Start the browser if it is not running; a call during a start waits for that start. */
	async start(): Promise<void> {
		// The pipe exists before the browser has answered, so `running` alone is not "started".
		if (this.starting) return this.starting;
		if (this.running) return;
		this.starting ??= this.launch().finally(() => {
			this.starting = undefined;
		});
		await this.starting;
	}

	private async launch(): Promise<void> {
		await this.close();
		const env = this.options.env ?? process.env;
		const executable = findBrowserExecutable(env);
		if (!executable) {
			throw new Error(
				env.FINGERS_BROWSER_PATH
					? `FINGERS_BROWSER_PATH does not name an executable: ${env.FINGERS_BROWSER_PATH}`
					: "No Chromium-based browser found. Install Chromium or Google Chrome, or set FINGERS_BROWSER_PATH.",
			);
		}
		const proxy = new FilterProxy({ policy: this.policy, log: this.options.log });
		await proxy.start();
		this.proxy = proxy;
		this.userDataDir = mkdtempSync(join(tmpdir(), "fingers-browser-"));
		const noSandbox =
			env.FINGERS_BROWSER_NO_SANDBOX === "1" || (process.platform === "linux" && process.getuid?.() === 0);
		const args = browserArguments({ userDataDir: this.userDataDir, proxyUrl: proxy.url, noSandbox });
		// Its own process group (POSIX), so close() can stop the helpers (zygote, renderers, GPU) too.
		const child = spawn(executable, args, {
			stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		this.child = child;
		this.stderrTail = "";
		this.stderrFatal = undefined;
		this.stderrErrors = [];
		let partial = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-2000);
			const lines = (partial + chunk).split("\n");
			partial = lines.pop() ?? "";
			if (partial.length > 4000) partial = "";
			for (const line of lines) this.noteStderrLine(line);
		});
		child.stderr?.once("end", () => {
			if (partial) this.noteStderrLine(partial);
			partial = "";
		});
		child.once("exit", (code, signal) => {
			this.log("debug", "browser exited", { code, signal });
		});
		const spawnError = new Promise<never>((_, reject) => child.once("error", reject));
		const cdp = new CdpPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
		this.cdp = cdp;
		try {
			await Promise.race([this.attach(cdp), spawnError]);
		} catch (error) {
			await this.close();
			const detail = this.startFailureDetail();
			throw new Error(`The browser did not start: ${(error as Error).message}${detail ? ` (${detail})` : ""}`);
		}
		this.log("info", "browser started", {
			pid: child.pid,
			executable: basename(executable),
			sandbox: !noSandbox,
			network_mode: this.policy.mode,
		});
	}

	/** Keeps Chrome's log lines at FATAL or ERROR level (`[pid:tid:time:FATAL:file(line)] message`). */
	private noteStderrLine(line: string): void {
		const match = /^\[[^\]]*:(FATAL|ERROR):[^\]]*\]\s*(.*)$/.exec(line.trim());
		if (!match) return;
		const message = match[2].slice(0, 500);
		// The first FATAL line is the reason Chrome aborted; of the errors, the latest few.
		if (match[1] === "FATAL") this.stderrFatal ??= `FATAL: ${message}`;
		else this.stderrErrors = [...this.stderrErrors, `ERROR: ${message}`].slice(-3);
	}

	/**
	 * Why the browser did not start, from its stderr: its FATAL line when it aborted (what follows is a
	 * stack trace and register dump), else its last ERROR lines, else the last lines it printed.
	 */
	private startFailureDetail(): string {
		if (this.stderrFatal) return this.stderrFatal;
		if (this.stderrErrors.length > 0) return this.stderrErrors.join(" | ");
		return this.stderrTail.trim().split("\n").slice(-3).join(" | ");
	}

	private async attach(cdp: CdpPipe): Promise<void> {
		await withTimeout(
			cdp.send("Browser.getVersion"),
			this.options.startTimeoutMs ?? START_TIMEOUT_MS,
			"the browser did not answer",
		);
		await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" });
		const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
		const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
		this.sessionId = sessionId;
		cdp.onEvent((event) => {
			if (event.sessionId === sessionId && event.method === "Page.javascriptDialogOpening") {
				void cdp.send("Page.handleJavaScriptDialog", { accept: false }, sessionId).catch(() => {});
			}
		});
		await cdp.send("Page.enable", {}, sessionId);
		await cdp.send("Runtime.enable", {}, sessionId);
		// Request events attribute blocked requests to the page; the browser's own background requests
		// (blocked and logged too) are left out of the tool result. Bodies are not buffered.
		cdp.onEvent((event) => {
			if (event.sessionId !== sessionId) return;
			const url =
				event.method === "Network.requestWillBeSent"
					? event.params.request?.url
					: event.method === "Network.webSocketCreated"
						? event.params.url
						: undefined;
			const target = typeof url === "string" ? requestTarget(url) : undefined;
			if (!target) return;
			this.pageRequests.push({ target, at: Date.now() });
			if (this.pageRequests.length > 2000) this.pageRequests.splice(0, 1000);
		});
		await cdp.send("Network.enable", { maxTotalBufferSize: 1, maxResourceBufferSize: 1 }, sessionId);
		await cdp.send(
			"Emulation.setDeviceMetricsOverride",
			{ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
			sessionId,
		);
		const { frameTree } = await cdp.send("Page.getFrameTree", {}, sessionId);
		this.mainFrameId = frameTree.frame.id;
	}

	/**
	 * A command to the page. While a navigation swaps the page's renderer (an error page is one), the
	 * browser answers "Not attached to an active page" for a moment: wait and retry, up to 3 s.
	 */
	private async page(method: string, params: Json = {}): Promise<Json> {
		for (let attempt = 0; ; attempt++) {
			if (!this.cdp || !this.sessionId) throw new Error("the browser is not running");
			try {
				return await this.cdp.send(method, params, this.sessionId);
			} catch (error) {
				if (attempt >= 30 || !/Not attached to an active page/i.test((error as Error).message)) throw error;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
	}

	private async evaluateValue(expression: string, timeoutMs = 10_000): Promise<any> {
		const reply = await this.page("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
			userGesture: true,
			timeout: timeoutMs,
		});
		if (reply.exceptionDetails) {
			const description = reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? "error";
			throw new Error(String(description).split("\n")[0]);
		}
		return reply.result?.value;
	}

	private async currentLocation(): Promise<{ url: string; title: string }> {
		const { currentIndex, entries } = await this.page("Page.getNavigationHistory");
		const entry = entries?.[currentIndex] ?? { url: "about:blank", title: "" };
		return { url: String(entry.url ?? ""), title: String(entry.title ?? "") };
	}

	/**
	 * After an action: refuse a page on a scheme that is not shown (file:, chrome:, data:, …) by leaving
	 * it for about:blank, and collect what the proxy blocked since `since`.
	 */
	private async report(since: number): Promise<ActionReport> {
		const location = await this.currentLocation();
		const scheme = (() => {
			try {
				return new URL(location.url).protocol;
			} catch {
				return "invalid:";
			}
		})();
		if (!SHOWN_SCHEMES.has(scheme)) {
			await this.page("Page.navigate", { url: "about:blank" }).catch(() => {});
			this.log("warn", "browser left a page on a scheme that is not shown", { scheme });
			throw new Error(`The page went to a ${scheme} URL; only http and https pages are shown.`);
		}
		const requested = new Set(this.pageRequests.filter((entry) => entry.at >= since).map((entry) => entry.target));
		const blocked = (this.proxy?.blockedSince(since) ?? []).filter((entry) =>
			requested.has(`${entry.host}:${entry.port}`),
		);
		return { ...location, blocked };
	}

	/** Wait for a navigation that an action may have started (up to `startMs` for it to begin). */
	private async settle(startMs: number, signal?: AbortSignal): Promise<void> {
		const cdp = this.cdp!;
		const frameId = this.mainFrameId;
		try {
			await cdp.waitFor(
				(event) =>
					event.sessionId === this.sessionId &&
					event.method === "Page.frameStartedLoading" &&
					event.params.frameId === frameId,
				startMs,
				signal,
			);
		} catch {
			return;
		}
		await cdp
			.waitFor(
				(event) =>
					event.sessionId === this.sessionId &&
					event.method === "Page.frameStoppedLoading" &&
					event.params.frameId === frameId,
				this.options.navigationTimeoutMs ?? 30_000,
				signal,
			)
			.catch(() => {});
	}

	async navigate(url: string, signal?: AbortSignal): Promise<ActionReport & { error?: string }> {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error(`Not a URL: ${url}`);
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error(`Only http and https URLs can be opened, not ${parsed.protocol}`);
		}
		await this.start();
		const since = Date.now();
		const cdp = this.cdp!;
		const loaded = cdp.waitFor(
			(event) =>
				event.sessionId === this.sessionId &&
				event.method === "Page.frameStoppedLoading" &&
				event.params.frameId === this.mainFrameId,
			this.options.navigationTimeoutMs ?? 30_000,
			signal,
		);
		loaded.catch(() => {});
		const started = Date.now();
		const reply = await this.page("Page.navigate", { url: parsed.href });
		let error: string | undefined = reply.errorText || undefined;
		if (!error) {
			try {
				await loaded;
			} catch (waitError) {
				if ((waitError as Error).message === "aborted") {
					await this.page("Page.stopLoading").catch(() => {});
					throw new Error("Navigation aborted");
				}
				error = "the page did not finish loading in time";
			}
		}
		const report = await this.report(since);
		// A refused plain-http request comes back as the proxy's 403 page, not as a network error.
		const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
		const host = normalizeHost(parsed.hostname);
		const refused = report.blocked.find((entry) => entry.host === host && entry.port === port);
		if (refused) error = `blocked by the run's network policy (${refused.reason})`;
		this.log("info", "browser navigate", {
			origin: originOf(parsed.href),
			ok: !error,
			error,
			blocked: report.blocked.length,
			duration_ms: Date.now() - started,
		});
		return { ...report, ...(error ? { error } : {}) };
	}

	async text(): Promise<PageText & { blocked: BlockedRequest[] }> {
		await this.start();
		const since = Date.now();
		const report = await this.report(since);
		const value = (await this.evaluateValue(TEXT_SCRIPT)) as Omit<PageText, "truncated">;
		const max = this.options.maxTextChars ?? 20_000;
		const text = String(value?.text ?? "");
		const links = Array.isArray(value?.links)
			? value.links.filter((link) => /^https?:/i.test(String(link.href)))
			: [];
		return {
			title: String(value?.title ?? report.title),
			url: report.url,
			text: text.length > max ? text.slice(0, max) : text,
			truncated: text.length > max,
			links,
			blocked: [],
		};
	}

	async click(selector: string, signal?: AbortSignal): Promise<ActionReport> {
		await this.start();
		const since = Date.now();
		const found = await this.evaluateValue(
			`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true; })()`,
		);
		if (!found) throw new Error(`No element matches ${selector}`);
		await this.settle(1_000, signal);
		const report = await this.report(since);
		this.log("info", "browser click", { origin: originOf(report.url), blocked: report.blocked.length });
		return report;
	}

	async type(selector: string, text: string, submit: boolean, signal?: AbortSignal): Promise<ActionReport> {
		await this.start();
		const since = Date.now();
		const found = await this.evaluateValue(
			`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); if ("value" in el) el.value = ""; return true; })()`,
		);
		if (!found) throw new Error(`No element matches ${selector}`);
		await this.page("Input.insertText", { text });
		if (submit) {
			const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
			await this.page("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...key });
			await this.page("Input.dispatchKeyEvent", { type: "keyUp", ...key });
			await this.settle(1_000, signal);
		}
		const report = await this.report(since);
		this.log("info", "browser type", { origin: originOf(report.url), submit, blocked: report.blocked.length });
		return report;
	}

	async evaluate(expression: string, signal?: AbortSignal): Promise<ActionReport & { value: unknown }> {
		await this.start();
		const since = Date.now();
		const value = await this.evaluateValue(expression);
		await this.settle(300, signal);
		const report = await this.report(since);
		this.log("info", "browser evaluate", { origin: originOf(report.url), blocked: report.blocked.length });
		return { ...report, value };
	}

	async screenshot(): Promise<ActionReport & { data: string }> {
		await this.start();
		const since = Date.now();
		const report = await this.report(since);
		const { data } = await this.page("Page.captureScreenshot", { format: "png" });
		return { ...report, data: String(data) };
	}

	async close(): Promise<void> {
		const cdp = this.cdp;
		const child = this.child;
		this.cdp = undefined;
		this.child = undefined;
		this.sessionId = undefined;
		if (cdp && !cdp.closed) await withTimeout(cdp.send("Browser.close"), 2_000, "close").catch(() => {});
		if (child && child.exitCode === null && child.signalCode === null) {
			const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
			child.kill("SIGTERM");
			if (
				!(await withTimeout(exited, 3_000, "exit").then(
					() => true,
					() => false,
				))
			) {
				child.kill("SIGKILL");
				await withTimeout(exited, 2_000, "exit").catch(() => {});
			}
		}
		// Helpers can outlive the browser process and keep writing the profile; stop the whole group.
		if (child?.pid && process.platform !== "win32") {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// The group is already gone.
			}
		}
		if (this.proxy) {
			await this.proxy.close();
			this.proxy = undefined;
		}
		if (this.userDataDir) {
			const userDataDir = this.userDataDir;
			this.userDataDir = undefined;
			// Asynchronous: a profile that is slow to remove must not stall the event loop (in managed
			// mode that is the RPC server's).
			await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch((error) => {
				this.log("warn", "browser profile not removed", { code: (error as NodeJS.ErrnoException).code });
			});
		}
		if (child) this.log("info", "browser closed", { pid: child.pid });
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
