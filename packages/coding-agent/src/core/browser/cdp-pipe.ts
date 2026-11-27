/**
 * A minimal Chrome DevTools Protocol client over `--remote-debugging-pipe` (the browser reads commands
 * from fd 3 and writes replies and events to fd 4, NUL-separated JSON). A pipe instead of a debugging
 * port means no other local process can attach to the browser.
 */
import type { Readable, Writable } from "node:stream";

type Json = Record<string, any>;

interface CdpEvent {
	method: string;
	params: Json;
	sessionId?: string;
}

interface Pending {
	resolve: (value: Json) => void;
	reject: (error: Error) => void;
	method: string;
}

class CdpError extends Error {
	readonly method: string;

	constructor(method: string, message: string) {
		super(`${method}: ${message}`);
		this.method = method;
	}
}

export class CdpPipe {
	private readonly writer: Writable;
	private nextId = 1;
	private buffer = "";
	private readonly pending = new Map<number, Pending>();
	private readonly listeners = new Set<(event: CdpEvent) => void>();
	private closedError: Error | undefined;

	constructor(writer: Writable, reader: Readable) {
		this.writer = writer;
		reader.setEncoding("utf8");
		reader.on("data", (chunk: string) => this.onData(chunk));
		reader.on("close", () => this.fail(new Error("the browser closed the DevTools pipe")));
		reader.on("error", (error) => this.fail(error));
		writer.on("error", (error) => this.fail(error));
	}

	get closed(): boolean {
		return this.closedError !== undefined;
	}

	send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
		if (this.closedError) return Promise.reject(this.closedError);
		const id = this.nextId++;
		const message = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
		return new Promise<Json>((resolve, reject) => {
			this.pending.set(id, { resolve, reject, method });
			this.writer.write(`${message}\0`);
		});
	}

	onEvent(listener: (event: CdpEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Resolve with the first event that matches, or reject after `timeoutMs` or on `signal`. */
	waitFor(match: (event: CdpEvent) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<CdpEvent> {
		return new Promise<CdpEvent>((resolve, reject) => {
			const done = (fn: () => void) => {
				clearTimeout(timer);
				off();
				signal?.removeEventListener("abort", onAbort);
				fn();
			};
			const off = this.onEvent((event) => {
				if (match(event)) done(() => resolve(event));
			});
			const timer = setTimeout(() => done(() => reject(new Error("timeout"))), timeoutMs);
			const onAbort = () => done(() => reject(new Error("aborted")));
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let end = this.buffer.indexOf("\0");
		while (end >= 0) {
			const text = this.buffer.slice(0, end);
			this.buffer = this.buffer.slice(end + 1);
			end = this.buffer.indexOf("\0");
			let message: Json;
			try {
				message = JSON.parse(text);
			} catch {
				continue;
			}
			if (typeof message.id === "number") {
				const pending = this.pending.get(message.id);
				if (!pending) continue;
				this.pending.delete(message.id);
				if (message.error) pending.reject(new CdpError(pending.method, String(message.error.message ?? "error")));
				else pending.resolve(message.result ?? {});
			} else if (typeof message.method === "string") {
				const event: CdpEvent = {
					method: message.method,
					params: message.params ?? {},
					sessionId: message.sessionId,
				};
				for (const listener of [...this.listeners]) listener(event);
			}
		}
	}

	private fail(error: Error): void {
		if (this.closedError) return;
		this.closedError = error;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}
