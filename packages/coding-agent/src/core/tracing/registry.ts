/**
 * The span exporters that are live in this process, by slot: `otlp` (the person's own OTLP destination, from the
 * environment) and `ee` (Eyes, which the terminal app's ee gate fills while the `eyes` feature is on and asks again
 * before every span). Managed RPC never uses it: there spans go to the host (`telemetry_span`).
 */
import type { SpanExporter } from "./spans.ts";

interface Slot {
	exporter: SpanExporter;
	isOn: () => boolean;
}

export class TelemetryExporters {
	private readonly slots = new Map<string, Slot>();

	/** Use this exporter in `slot` from now on; `isOn` is asked before every span. */
	set(slot: string, exporter: SpanExporter, isOn: () => boolean = () => true): void {
		this.slots.set(slot, { exporter, isOn });
	}

	clear(slot: string): void {
		this.slots.delete(slot);
	}

	has(slot: string): boolean {
		return this.slots.has(slot);
	}

	/** The exporters that take spans right now. */
	active(): SpanExporter[] {
		const live: SpanExporter[] = [];
		for (const slot of this.slots.values()) {
			let on = false;
			try {
				on = slot.isOn();
			} catch {
				on = false;
			}
			if (on) live.push(slot.exporter);
		}
		return live;
	}

	/** The console link of the last run's trace from the first live exporter that has one (Eyes). */
	lastTraceLink(): string | undefined {
		for (const exporter of this.active()) {
			try {
				const link = exporter.lastTraceLink?.();
				if (link) return link;
			} catch {
				// An exporter's link is a nicety: a throwing one is skipped.
			}
		}
		return undefined;
	}

	/** Send what every exporter has queued (a run ended, the session shuts down). Never rejects. */
	async flush(): Promise<void> {
		await Promise.all([...this.slots.values()].map((slot) => slot.exporter.flush?.().catch(() => {})));
	}
}

/** This process' exporters: the built-in `telemetry` extension sends to them. */
export const telemetryExporters = new TelemetryExporters();
