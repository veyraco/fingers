/**
 * The browser tool's filtering proxy: an HTTP proxy on 127.0.0.1 that every request of the headless
 * browser goes through (`--proxy-server`, loopback included). It applies the run's host policy to the
 * host and port of each request (CONNECT for https and WebSockets, absolute-form requests for plain
 * http), resolves the name itself, refuses when any resolved address is link-local or unspecified, and
 * connects to the vetted address, so a name cannot resolve to something else between check and connect.
 * Blocked attempts are kept for the tool result and logged with the host and port only.
 */
import { lookup } from "node:dns/promises";
import {
	createServer,
	request as httpRequest,
	type IncomingMessage,
	type OutgoingHttpHeaders,
	type Server,
	type ServerResponse,
} from "node:http";
import { type AddressInfo, connect, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { blockedAddressReason, type HostPolicy, normalizeHost } from "./host-policy.ts";

export interface BlockedRequest {
	host: string;
	port: number;
	reason: string;
	at: number;
}

export type BrowserLog = (level: "debug" | "info" | "warn", msg: string, fields?: Record<string, unknown>) => void;

export interface FilterProxyOptions {
	policy: HostPolicy;
	log?: BrowserLog;
	/** Name resolution (tests replace it). Returns every address of the name. */
	resolve?: (host: string) => Promise<string[]>;
	now?: () => number;
}

const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-connection",
	"proxy-authorization",
	"proxy-authenticate",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

async function defaultResolve(host: string): Promise<string[]> {
	const records = await lookup(host, { all: true, verbatim: true });
	return records.map((record) => record.address);
}

/** Split `host:port` / `[v6]:port` from a CONNECT target. */
function parseAuthority(authority: string): { host: string; port: number } | undefined {
	const match = authority.match(/^\[([^\]]+)\]:(\d{1,5})$/) ?? authority.match(/^([^:[\]]+):(\d{1,5})$/);
	if (!match) return undefined;
	const port = Number(match[2]);
	if (port < 1 || port > 65535) return undefined;
	return { host: normalizeHost(match[1]), port };
}

export class FilterProxy {
	private readonly options: FilterProxyOptions;
	private readonly server: Server;
	private readonly sockets = new Set<Socket | Duplex>();
	private readonly blockedList: BlockedRequest[] = [];
	private port = 0;

	constructor(options: FilterProxyOptions) {
		this.options = options;
		this.server = createServer((req, res) => {
			void this.handleHttp(req, res);
		});
		this.server.on("connect", (req, socket, head) => {
			void this.handleConnect(req, socket, head);
		});
		this.server.on("connection", (socket) => {
			this.sockets.add(socket);
			socket.on("close", () => this.sockets.delete(socket));
		});
		this.server.on("clientError", (_error, socket) => socket.destroy());
	}

	/** `http://127.0.0.1:<port>`, for `--proxy-server`. */
	get url(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	async start(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(0, "127.0.0.1", () => {
				this.server.off("error", reject);
				resolve();
			});
		});
		this.port = (this.server.address() as AddressInfo).port;
	}

	async close(): Promise<void> {
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	/** Blocked attempts since `since` (epoch ms), oldest first. */
	blockedSince(since: number): BlockedRequest[] {
		return this.blockedList.filter((entry) => entry.at >= since);
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private block(host: string, port: number, reason: string): void {
		this.blockedList.push({ host, port, reason, at: this.now() });
		if (this.blockedList.length > 500) this.blockedList.shift();
		this.options.log?.("warn", "browser request blocked", { host, port, reason });
	}

	/** Policy, then resolution: the address to connect to, or undefined after recording the block. */
	private async vet(host: string, port: number): Promise<string | undefined> {
		if (port === this.port && (host === "127.0.0.1" || host === "localhost" || host === "::1")) {
			this.block(host, port, "the browser proxy itself");
			return undefined;
		}
		const decision = this.options.policy.check(host, port);
		if (!decision.allowed) {
			this.block(host, port, decision.reason);
			return undefined;
		}
		let addresses: string[];
		try {
			addresses = isIP(host) ? [host] : await (this.options.resolve ?? defaultResolve)(host);
		} catch (error) {
			this.options.log?.("debug", "browser host did not resolve", {
				host,
				port,
				code: (error as NodeJS.ErrnoException).code,
			});
			return undefined;
		}
		const bad = addresses.map((address) => blockedAddressReason(address)).find((reason) => reason !== undefined);
		if (bad || addresses.length === 0) {
			this.block(host, port, bad ? `resolves to a ${bad}` : "no address");
			return undefined;
		}
		return addresses[0];
	}

	private async handleConnect(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		this.sockets.add(socket);
		socket.on("close", () => this.sockets.delete(socket));
		socket.on("error", () => socket.destroy());
		const target = parseAuthority(req.url ?? "");
		if (!target) {
			socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
			return;
		}
		const address = await this.vet(target.host, target.port);
		if (!address) {
			socket.end("HTTP/1.1 403 Forbidden\r\nX-Fingers-Blocked: network policy\r\n\r\n");
			return;
		}
		const upstream = connect({ host: address, port: target.port });
		this.sockets.add(upstream);
		upstream.on("close", () => this.sockets.delete(upstream));
		upstream.once("connect", () => {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length > 0) upstream.write(head);
			upstream.pipe(socket);
			socket.pipe(upstream);
		});
		upstream.on("error", () => {
			if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
			upstream.destroy();
		});
		socket.on("close", () => upstream.destroy());
	}

	private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
		let url: URL;
		try {
			url = new URL(req.url ?? "");
		} catch {
			res.writeHead(400).end();
			return;
		}
		if (url.protocol !== "http:") {
			res.writeHead(400).end();
			return;
		}
		const host = normalizeHost(url.hostname);
		const port = url.port ? Number(url.port) : 80;
		const address = await this.vet(host, port);
		if (!address) {
			res.writeHead(403, { "content-type": "text/plain", "x-fingers-blocked": "network policy" });
			res.end(`Blocked by the run's network policy: ${host}:${port}\n`);
			return;
		}
		const headers: OutgoingHttpHeaders = {};
		for (const [name, value] of Object.entries(req.headers)) {
			if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
		}
		headers.host = url.host;
		const upstream = httpRequest(
			{
				host: address,
				port,
				method: req.method,
				path: `${url.pathname}${url.search}`,
				headers,
			},
			(upstreamRes) => {
				const outHeaders: Record<string, string | string[]> = {};
				for (const [name, value] of Object.entries(upstreamRes.headers)) {
					if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) outHeaders[name] = value;
				}
				res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
				upstreamRes.pipe(res);
			},
		);
		upstream.on("error", () => {
			if (!res.headersSent) res.writeHead(502);
			res.end();
		});
		req.pipe(upstream);
	}
}
