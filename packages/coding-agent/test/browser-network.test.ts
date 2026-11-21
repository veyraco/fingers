/**
 * The browser tool's network gate (core/browser): the host policy of `configure.network` and the
 * filtering proxy every browser request goes through.
 */
import { createServer, request, type Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FilterProxy } from "../src/core/browser/filter-proxy.ts";
import { blockedAddressReason, HostPolicy } from "../src/core/browser/host-policy.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("browser host policy", () => {
	it("open mode allows hosts but never link-local, unspecified or metadata addresses", () => {
		const policy = new HostPolicy(undefined);
		expect(policy.mode).toBe("open");
		expect(policy.check("example.com", 443)).toEqual({ allowed: true });
		expect(policy.check("127.0.0.1", 3000)).toEqual({ allowed: true });
		for (const host of [
			"169.254.169.254",
			"[fe80::1]",
			"fe80::abcd%en0",
			"::ffff:169.254.169.254",
			"::ffff:a9fe:a9fe",
			"64:ff9b::a9fe:a9fe",
			"fd00:ec2::254",
			"0.0.0.0",
			"::",
			"metadata.google.internal",
			"METADATA.google.internal.",
		]) {
			expect(policy.check(host, 80), host).toMatchObject({ allowed: false });
		}
	});

	it("allow_list allows only listed hosts, on 80/443 unless a port is given", () => {
		const policy = new HostPolicy({
			mode: "allow_list",
			hosts: ["registry.npmjs.org", "*.example.com", "docs.example.org:8443", "[2001:db8::1]:443"],
		});
		expect(policy.check("registry.npmjs.org", 443)).toEqual({ allowed: true });
		expect(policy.check("Registry.NPMJS.org.", 80)).toEqual({ allowed: true });
		expect(policy.check("registry.npmjs.org", 8080)).toMatchObject({ allowed: false });
		expect(policy.check("a.b.example.com", 443)).toEqual({ allowed: true });
		expect(policy.check("example.com", 443)).toMatchObject({ allowed: false });
		expect(policy.check("evilexample.com", 443)).toMatchObject({ allowed: false });
		expect(policy.check("docs.example.org", 8443)).toEqual({ allowed: true });
		expect(policy.check("docs.example.org", 443)).toMatchObject({ allowed: false });
		expect(policy.check("[2001:db8::1]", 443)).toEqual({ allowed: true });
		expect(policy.check("pypi.org", 443)).toEqual({
			allowed: false,
			reason: "not in the run's network allow list",
		});
	});

	it("an empty allow list blocks every host, and a listed link-local address stays blocked", () => {
		expect(new HostPolicy({ mode: "allow_list", hosts: [] }).check("example.com", 443)).toMatchObject({
			allowed: false,
		});
		expect(
			new HostPolicy({ mode: "allow_list", hosts: ["169.254.169.254"] }).check("169.254.169.254", 80),
		).toMatchObject({ allowed: false, reason: "link-local address" });
	});

	it("refuses host entries that are not hosts", () => {
		for (const entry of ["https://example.com", "example.com/path", "user@example.com", "*", "a.*.com", "x:99999"]) {
			expect(() => new HostPolicy({ mode: "allow_list", hosts: [entry] }), entry).toThrow(/network.hosts/);
		}
		expect(() => new HostPolicy({ mode: "org_allowlist" as "open" })).toThrow(/network.mode/);
	});

	it("names the blocked address kinds", () => {
		expect(blockedAddressReason("169.254.1.2")).toBe("link-local address");
		expect(blockedAddressReason("fe80::1")).toBe("link-local address");
		expect(blockedAddressReason("fd00:ec2::254")).toBe("cloud metadata address");
		expect(blockedAddressReason("10.0.0.1")).toBeUndefined();
		expect(blockedAddressReason("::1")).toBeUndefined();
	});
});

async function upstream(): Promise<{ server: Server; port: number; hits: string[] }> {
	const hits: string[] = [];
	const server = createServer((req, res) => {
		hits.push(`${req.method} ${req.url} host=${req.headers.host}`);
		res.writeHead(200, { "content-type": "text/plain" }).end("hello from upstream");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return { server, port: (server.address() as AddressInfo).port, hits };
}

async function startProxy(policy: HostPolicy, resolve?: (host: string) => Promise<string[]>) {
	const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
	const proxy = new FilterProxy({ policy, resolve, log: (level, msg, fields) => logs.push({ level, msg, fields }) });
	await proxy.start();
	cleanups.push(() => proxy.close());
	return { proxy, logs, port: Number(new URL(proxy.url).port) };
}

function viaProxy(proxyPort: number, url: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: url }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => {
				body += chunk;
			});
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

function connectVia(proxyPort: number, target: string, payload?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = connect(proxyPort, "127.0.0.1", () => {
			socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
		});
		let data = "";
		let sent = false;
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			data += chunk;
			if (!sent && payload && data.includes("\r\n\r\n") && data.startsWith("HTTP/1.1 200")) {
				sent = true;
				socket.write(payload);
			}
		});
		socket.on("end", () => resolve(data));
		socket.on("close", () => resolve(data));
		socket.on("error", reject);
		setTimeout(() => {
			socket.destroy();
			resolve(data);
		}, 2_000);
	});
}

describe("browser filtering proxy", () => {
	it("forwards plain http to an allowed host and refuses another port without contacting it", async () => {
		const allowed = await upstream();
		const other = await upstream();
		const { proxy, logs, port } = await startProxy(
			new HostPolicy({ mode: "allow_list", hosts: [`127.0.0.1:${allowed.port}`] }),
		);
		const since = Date.now();
		const ok = await viaProxy(port, `http://127.0.0.1:${allowed.port}/page?q=1`);
		expect(ok).toEqual({ status: 200, body: "hello from upstream" });
		expect(allowed.hits).toEqual([`GET /page?q=1 host=127.0.0.1:${allowed.port}`]);
		const refused = await viaProxy(port, `http://127.0.0.1:${other.port}/secret`);
		expect(refused.status).toBe(403);
		expect(other.hits).toEqual([]);
		expect(proxy.blockedSince(since)).toMatchObject([
			{ host: "127.0.0.1", port: other.port, reason: "not in the run's network allow list" },
		]);
		const warn = logs.find((log) => log.msg === "browser request blocked")!;
		expect(warn.fields).toEqual({
			host: "127.0.0.1",
			port: other.port,
			reason: "not in the run's network allow list",
		});
		expect(JSON.stringify(logs)).not.toContain("/secret");
	});

	it("tunnels CONNECT to an allowed host and refuses a blocked one", async () => {
		const allowed = await upstream();
		const other = await upstream();
		const { port } = await startProxy(new HostPolicy({ mode: "allow_list", hosts: [`127.0.0.1:${allowed.port}`] }));
		const tunneled = await connectVia(
			port,
			`127.0.0.1:${allowed.port}`,
			`GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
		);
		expect(tunneled).toMatch(/^HTTP\/1.1 200 Connection Established/);
		expect(tunneled).toContain("hello from upstream");
		const refused = await connectVia(port, `127.0.0.1:${other.port}`, "GET / HTTP/1.1\r\n\r\n");
		expect(refused).toMatch(/^HTTP\/1.1 403/);
		expect(other.hits).toEqual([]);
	});

	it("refuses an allowed name that resolves to a link-local address", async () => {
		const { proxy, port } = await startProxy(
			new HostPolicy({ mode: "allow_list", hosts: ["rebind.example.com"] }),
			async () => ["169.254.169.254"],
		);
		const since = Date.now();
		const refused = await connectVia(port, "rebind.example.com:443");
		expect(refused).toMatch(/^HTTP\/1.1 403/);
		expect(proxy.blockedSince(since)).toMatchObject([
			{ host: "rebind.example.com", port: 443, reason: "resolves to a link-local address" },
		]);
	});

	it("refuses requests to the proxy itself and non-http absolute forms", async () => {
		const { port } = await startProxy(new HostPolicy(undefined));
		expect((await connectVia(port, `127.0.0.1:${port}`)).startsWith("HTTP/1.1 403")).toBe(true);
		expect((await viaProxy(port, "ftp://127.0.0.1/x")).status).toBe(400);
	});
});
