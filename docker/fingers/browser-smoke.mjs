#!/usr/bin/env node
/**
 * Browser smoke test for the Fingers image (release workflow) and for a local build:
 * the `browser` tool opens a page on an allowed local server, reads it, and every request to a host
 * outside the allow list (a second local server, a public name) is refused without reaching it.
 *
 *   docker run --rm -v "$PWD/docker/fingers/browser-smoke.mjs:/opt/smoke/browser-smoke.mjs:ro" \
 *     --entrypoint node fingers:smoke /opt/smoke/browser-smoke.mjs
 *   node docker/fingers/browser-smoke.mjs packages/coding-agent/dist/index.js     # local build
 *
 * Exit 0 on success, 1 with a reason otherwise. Prints one JSON line per check.
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const modulePath = process.argv[2] ?? "/opt/fingers/node_modules/@veyraco/fingers/dist/index.js";
const { BrowserSession, createBrowserToolDefinition, findBrowserExecutable } = await import(
	pathToFileURL(modulePath).href
);

function fail(reason) {
	console.log(JSON.stringify({ check: "browser-smoke", ok: false, reason }));
	process.exit(1);
}

async function serve(handler) {
	const hits = [];
	const server = createServer((req, res) => {
		hits.push(String(req.url));
		const body = handler(req);
		res.writeHead(200, { "content-type": "text/html" }).end(body);
	});
	server.on("upgrade", (req, socket) => {
		hits.push(`upgrade ${req.url}`);
		socket.destroy();
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, port: server.address().port, hits };
}

const executable = findBrowserExecutable();
if (!executable) fail("no Chromium-based browser found");
console.log(JSON.stringify({ check: "executable", ok: true, executable }));

const outside = await serve(() => "OUTSIDE");
const site = await serve(
	() => `<!doctype html><title>Smoke page</title><h1>Fingers browser smoke</h1>
<img src="http://127.0.0.1:${outside.port}/pixel.png">
<script>fetch("http://127.0.0.1:${outside.port}/x").catch(() => {}); try { new WebSocket("ws://127.0.0.1:${outside.port}/ws"); } catch {}</script>`,
);
const session = new BrowserSession({
	network: { mode: "allow_list", hosts: [`127.0.0.1:${site.port}`] },
	log: (level, msg, fields) => {
		if (level !== "debug") process.stderr.write(`${JSON.stringify({ level, msg, ...fields })}\n`);
	},
});
const tool = createBrowserToolDefinition(session);
const call = (params) => tool.execute("smoke", params, undefined, undefined, {});
const text = (res) => res.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");

try {
	const opened = await call({ action: "navigate", url: `http://127.0.0.1:${site.port}/` });
	if (!text(opened).includes("Title: Smoke page")) fail(`page did not open: ${text(opened)}`);
	await new Promise((resolve) => setTimeout(resolve, 1000));
	const page = await call({ action: "text" });
	if (!text(page).includes("Fingers browser smoke")) fail("page text missing");
	console.log(JSON.stringify({ check: "allowed page", ok: true }));

	const external = await call({ action: "navigate", url: "https://example.com/" });
	if (!text(external).includes("example.com:443")) fail(`public host not refused: ${text(external)}`);
	console.log(JSON.stringify({ check: "public host refused", ok: true }));

	if (outside.hits.length > 0) fail(`a blocked host was reached: ${outside.hits.join(", ")}`);
	console.log(JSON.stringify({ check: "blocked local host never reached", ok: true }));

	const shot = await call({ action: "screenshot" });
	if (shot.content[0]?.type !== "image") fail("no screenshot");
	console.log(JSON.stringify({ check: "screenshot", ok: true }));
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
} finally {
	await session.close();
	site.server.close();
	outside.server.close();
}
console.log(JSON.stringify({ check: "browser-smoke", ok: true }));
