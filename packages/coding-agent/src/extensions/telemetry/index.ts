/**
 * Open core: the built-in extension that traces sessions (F21). It is MIT and sends nothing by itself: spans go only
 * to the process' exporters (core/tracing/registry.ts), which are the person's own OTLP destination when
 * FINGERS_OTLP_ENDPOINT (or FINGERS_OTLP_TRACES_ENDPOINT) is set, and Eyes while the ee feature is on in the terminal
 * app. With neither it makes no span and no request.
 */

import { VERSION } from "../../config.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../core/extensions/types.ts";
import { createTelemetryExtension } from "../../core/tracing/extension.ts";
import { OtlpHttpExporter, otlpConfigFromEnv } from "../../core/tracing/otlp.ts";
import { type TelemetryExporters, telemetryExporters } from "../../core/tracing/registry.ts";

/** The slot of the person's own OTLP destination. */
export const OTLP_SLOT = "otlp";

const MIN_SECRET_CHARS = 8;

export function createBuiltinTelemetryExtension(
	exporters: TelemetryExporters = telemetryExporters,
	env: NodeJS.ProcessEnv = process.env,
): ExtensionFactory {
	let configured = false;
	let configError: string | undefined;
	let headerSecrets: string[] = [];
	const redactSecrets = (text: string) =>
		headerSecrets.reduce((result, secret) => result.split(secret).join("[redacted]"), text);
	/** The first failed or refused send is told once per process (a wrong path, a 401 from wrong headers). */
	let sendFailureTold = false;
	let pendingSendFailure: string | undefined;
	let notify: ((message: string) => void) | undefined;
	const tellSendFailure = () => {
		if (sendFailureTold || !pendingSendFailure || !notify) return;
		sendFailureTold = true;
		notify(
			`OTLP telemetry could not be sent: ${pendingSendFailure}. Check FINGERS_OTLP_ENDPOINT and FINGERS_OTLP_HEADERS.`,
		);
		pendingSendFailure = undefined;
	};
	/** The OTLP destination from the environment, set up once per process on first use. */
	const configure = () => {
		if (configured) return;
		configured = true;
		try {
			const config = otlpConfigFromEnv(env);
			if (!config) return;
			headerSecrets = Object.values(config.headers).filter((value) => value.length >= MIN_SECRET_CHARS);
			exporters.set(
				OTLP_SLOT,
				new OtlpHttpExporter({
					url: config.url,
					headers: () => config.headers,
					content: config.content,
					version: VERSION,
					onError: (error) => {
						if (sendFailureTold || pendingSendFailure) return;
						const message = error instanceof Error ? error.message : String(error);
						pendingSendFailure = redactSecrets(message.replace(/\s+/g, " ").trim()).slice(0, 200);
						tellSendFailure();
					},
				}),
			);
		} catch (error) {
			configError = error instanceof Error ? error.message : String(error);
		}
	};
	const telemetry = createTelemetryExtension({
		exporters: () => exporters.active(),
		flush: () => exporters.flush(),
		mask: { redactSecrets },
	});
	return (fingers: ExtensionAPI) => {
		configure();
		fingers.on("session_start", (_event, ctx) => {
			if (configError && ctx.hasUI) ctx.ui.notify(`OTLP telemetry is off: ${configError}`, "warning");
			if (ctx.hasUI) {
				notify = (message) => ctx.ui.notify(message, "warning");
				tellSendFailure();
			}
		});
		return telemetry(fingers);
	};
}

export default createBuiltinTelemetryExtension();
