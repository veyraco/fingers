// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * Eyes telemetry in the terminal app (F21): while the `eyes` feature is on (signed in, Fingers on for the
 * organization, a tier that includes Eyes), the spans of the person's sessions go to Veyra Eyes as an ordinary OTLP
 * source (platform contracts/v1/eyes-feed.md, "Fingers on a person's machine"): OTLP/HTTP JSON at
 * `<api>/eyes/otlp/v1/traces` with the person's token for Eyes (`aud: eyes`), `service.name = fingers` and no
 * `veyra.app` (a person's token is not a feed). Metadata only: no prompts, answers, code or tool arguments.
 *
 * Spans belong to the organization that was signed in when they were made: each organization has its own exporter,
 * and a batch is dropped rather than sent once the sign-in moved to another organization. `/eyes` shows the status and
 * the link to the last run's trace in the Eyes console, `/eyes off` and `/eyes on` stop and resume sending.
 *
 * Managed RPC (Hands) never gets here: there Fingers holds no Veyra token and relays its spans to the host.
 */
import type { EeCommandContext, EeHost, EeVeyraApi, FingersSpan, SpanExporter } from "@veyraco/fingers";

type QueueingExporter = SpanExporter & { flush(): Promise<void> };

/** `<api>/eyes/otlp/v1/traces` for the API base `<api>/eyes/v1`. */
export function eyesTracesUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/otlp/v1/traces`;
}

/**
 * The Eyes console link to a trace (`https://eyes.veyra.so/<org code>/traces/<trace id>`), from the API origin
 * (`api.<domain>` pairs with `eyes.<domain>`); undefined when the API origin is not `api.<domain>` or the
 * organization's code is unknown.
 */
export function eyesTraceLink(baseUrl: string, orgCode: string | undefined, traceId: string): string | undefined {
	if (!orgCode) return undefined;
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return undefined;
	}
	if (!url.hostname.startsWith("api.")) return undefined;
	const host = `eyes.${url.hostname.slice("api.".length)}${url.port ? `:${url.port}` : ""}`;
	return `${url.protocol}//${host}/${encodeURIComponent(orgCode.toLowerCase())}/traces/${encodeURIComponent(traceId)}`;
}

function oneLine(text: string, max = 200): string {
	const flat = text
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

const USAGE = "Usage: /eyes, /eyes open, /eyes off, /eyes on";

export class EyesTelemetry {
	private api: EeVeyraApi | undefined;
	private createExporter: EeHost["createOtlpExporter"] | undefined;
	private paused = false;
	/** One exporter per organization: a batch never goes out with another organization's token. */
	private readonly exporters = new Map<string, QueueingExporter>();
	private lastTrace: { org: string; traceId: string } | undefined;
	private lastError: string | undefined;

	/** What the core sends spans to (metadata only). */
	readonly exporter: SpanExporter = {
		content: false,
		export: (span) => this.export(span),
		flush: () => this.flush(),
	};

	/** Called on every activation while `eyes` is on. */
	attach(host: EeHost): void {
		const api = host.veyraApi("eyes");
		if (api?.baseUrl !== this.api?.baseUrl) this.dropExporters();
		this.api = api;
		this.createExporter = host.createOtlpExporter;
		host.registerTelemetryExporter("eyes", this.exporter);
		host.registerCommand("eyes", (context) => this.command(context));
	}

	/** Eyes is off: forget the sign-in's API (the core already stopped sending spans here). */
	reset(): void {
		this.api = undefined;
		this.dropExporters();
	}

	private dropExporters(): void {
		for (const exporter of this.exporters.values()) void exporter.flush().catch(() => {});
		this.exporters.clear();
	}

	private exporterFor(api: EeVeyraApi, org: string): QueueingExporter | undefined {
		let exporter = this.exporters.get(org);
		if (exporter || !this.createExporter) return exporter;
		exporter = this.createExporter({
			url: eyesTracesUrl(api.baseUrl),
			headers: async () => {
				const token = await api.accessToken({ signal: AbortSignal.timeout(10_000) });
				return { authorization: `Bearer ${token}` };
			},
			// The sign-in moved to another organization: this organization's spans are not sent with its token.
			allowSend: () => this.api === api && api.org === org,
			onError: (error) => {
				this.lastError = oneLine(error instanceof Error ? error.message : String(error));
			},
		});
		this.exporters.set(org, exporter);
		return exporter;
	}

	private export(span: FingersSpan): void {
		const api = this.api;
		const org = api?.org;
		if (this.paused || !api || !org) return;
		const exporter = this.exporterFor(api, org);
		if (!exporter) return;
		exporter.export(span);
		// A run's `invoke_agent` span has no parent: its trace is the run's.
		if (!span.parent_span_id) this.lastTrace = { org, traceId: span.trace_id };
	}

	private async flush(): Promise<void> {
		await Promise.all([...this.exporters.values()].map((exporter) => exporter.flush().catch(() => {})));
	}

	/** The console link of the last run's trace in the signed-in organization, if any. */
	lastTraceLink(): string | undefined {
		const api = this.api;
		const trace = this.lastTrace;
		if (!api || !trace || trace.org !== api.org) return undefined;
		return eyesTraceLink(api.baseUrl, api.orgCode, trace.traceId);
	}

	command(context: EeCommandContext): void {
		const verb = context.args.split(/\s+/)[0] ?? "";
		const org = context.entitlement.orgName ?? context.entitlement.org ?? "your organization";
		switch (verb) {
			case "": {
				if (this.paused) {
					context.showStatus("Eyes telemetry is off in this session. /eyes on turns it back on.");
					return;
				}
				const link = this.lastTraceLink();
				const lines = [
					`Eyes telemetry is on for ${org}: each run's model and tool calls go to Veyra Eyes as a trace (timings, models, tokens and errors; no prompts, answers or code). /eyes off stops it for this session.`,
				];
				if (link) lines.push(`Last trace: ${link}`);
				if (this.lastError) lines.push(`Last send failed: ${this.lastError}`);
				context.showStatus(lines.join("\n"));
				return;
			}
			case "open": {
				const link = this.lastTraceLink();
				if (link) context.showStatus(`Open in Eyes: ${link}`);
				else
					context.showWarning(
						this.lastTrace
							? "The Eyes console link is not known for this sign-in (no organization code or a custom API address)."
							: "No trace yet in this session: run a prompt first.",
					);
				return;
			}
			case "off":
				this.paused = true;
				void this.flush();
				context.showStatus("Eyes telemetry is off until you run /eyes on or restart Fingers.");
				return;
			case "on":
				this.paused = false;
				context.showStatus("Eyes telemetry is on.");
				return;
			default:
				context.showWarning(USAGE);
		}
	}
}
