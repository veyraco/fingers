/**
 * The relay memory provider of managed RPC: each operation is a `memory_request` the host answers; Fingers
 * never names a space or an organization, never waits past the timeout, and fails closed on an answer that is not
 * the contract's.
 */
import { describe, expect, it } from "vitest";
import { type MemoryRequestRecord, RelayMemoryProvider } from "../src/core/memory/relay.ts";
import { MemoryUnavailableError } from "../src/core/memory/types.ts";

function relay(timeoutMs?: ConstructorParameters<typeof RelayMemoryProvider>[0]["timeoutMs"]) {
	const sent: MemoryRequestRecord[] = [];
	const provider = new RelayMemoryProvider({ emit: (record) => sent.push(record), key: "hands-run:run_1", timeoutMs });
	return { provider, sent };
}

async function rejection(promise: Promise<unknown>): Promise<MemoryUnavailableError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(MemoryUnavailableError);
		return error as MemoryUnavailableError;
	}
	throw new Error("expected a rejection");
}

describe("relay memory provider", () => {
	it("is the run's own memory and refuses to start without an owner key", () => {
		expect(relay().provider.key).toBe("hands-run:run_1");
		expect(() => new RelayMemoryProvider({ emit: () => {}, key: "" })).toThrow(/needs a key/);
	});

	it("sends each operation as a memory_request and returns the host's answer", async () => {
		const { provider, sent } = relay();
		const context = provider.context({ task: "t", max_tokens: 100, format: "markdown" });
		expect(sent[0]).toEqual({
			type: "memory_request",
			id: "memreq_1",
			op: "context",
			body: { task: "t", max_tokens: 100, format: "markdown" },
			timeout_ms: 3000,
		});
		expect(
			provider.respond({ type: "memory_response", id: "memreq_1", ok: true, data: { context: "c", tokens: 3 } }),
		).toBe(true);
		await expect(context).resolves.toEqual({ context: "c", tokens: 3 });

		const recall = provider.recall({ query: "q", limit: 2 });
		provider.respond({
			type: "memory_response",
			id: "memreq_2",
			ok: true,
			data: { data: [{ ref: "lt_1 v1", kind: "fact", text: "x", score: 0.5 }, { nope: true }] },
		});
		await expect(recall).resolves.toEqual([{ ref: "lt_1 v1", kind: "fact", text: "x", score: 0.5 }]);

		const remember = provider.remember({ type: "fact", text: "x" });
		provider.respond({
			type: "memory_response",
			id: "memreq_3",
			ok: true,
			data: { id: "lt_2", merged_into: "lt_1" },
		});
		await expect(remember).resolves.toEqual({ id: "lt_2", merged_into: "lt_1" });

		const events = provider.reportEvents([{ id: "e1", kind: "outcome", at: "2026-11-26T00:00:00Z" }]);
		expect(sent[3]!.body).toEqual({ events: [{ id: "e1", kind: "outcome", at: "2026-11-26T00:00:00Z" }] });
		provider.respond({ type: "memory_response", id: "memreq_4", ok: true, data: { accepted: 1, duplicates: 0 } });
		await expect(events).resolves.toEqual({ accepted: 1, duplicates: 0 });
		expect(provider.waiting).toBe(0);
	});

	it("never sends a space or an organization in the body", async () => {
		const { provider, sent } = relay();
		void provider
			.recall({ query: "q", space_id: "sp_other", org_id: "org_x", brain_space_id: "sp_y" } as never)
			.catch(() => {});
		expect(sent[0]!.body).toEqual({ query: "q" });
		provider.close();
	});

	it("fails with the host's error, on an answer that is not the contract's, and on a late or unknown id", async () => {
		const { provider } = relay();
		const failed = provider.context({ task: "t", max_tokens: 100 });
		provider.respond({
			type: "memory_response",
			id: "memreq_1",
			ok: false,
			error: { code: "spend_limit_reached", message: "cap" },
		});
		expect(await rejection(failed)).toMatchObject({ code: "spend_limit_reached", message: "cap" });

		const malformed = provider.context({ task: "t", max_tokens: 100 });
		provider.respond({ type: "memory_response", id: "memreq_2", ok: true, data: { tokens: 1 } });
		expect((await rejection(malformed)).code).toBe("invalid_response");

		const noData = provider.remember({ type: "fact", text: "x" });
		provider.respond({ type: "memory_response", id: "memreq_3", ok: true });
		expect((await rejection(noData)).code).toBe("invalid_response");

		expect(provider.respond({ type: "memory_response", id: "memreq_3", ok: true, data: { id: "late" } })).toBe(false);
		expect(provider.respond({ type: "memory_response", id: "memreq_77", ok: true, data: {} })).toBe(false);
	});

	it("gives up after the timeout, on abort and when closed", async () => {
		const { provider } = relay({ context: 20 });
		expect((await rejection(provider.context({ task: "t", max_tokens: 100 }))).code).toBe("timeout");
		expect(provider.waiting).toBe(0);

		const controller = new AbortController();
		const aborted = provider.recall({ query: "q" }, { signal: controller.signal });
		controller.abort();
		expect((await rejection(aborted)).code).toBe("aborted");

		const pending = provider.remember({ type: "fact", text: "x" });
		provider.close();
		expect((await rejection(pending)).code).toBe("closed");
		expect((await rejection(provider.recall({ query: "q" }))).code).toBe("closed");
		expect(provider.waiting).toBe(0);
	});
});
