import { type ClientIdentity, FINGERS_ATTRIBUTION } from "@veyraco/fingers-ai";
import { VERSION } from "../config.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { isInstallTelemetryEnabled } from "./telemetry.ts";

/**
 * How fingers' requests identify it to providers: a detailed `User-Agent` with fingers' version, and attribution to fingers as a
 * CLI agent while the attribution setting (`enableInstallTelemetry`) is on.
 */
export function getClientIdentity(settingsManager: SettingsManager): ClientIdentity {
	return {
		userAgent: "detailed",
		version: VERSION,
		attribution: isInstallTelemetryEnabled(settingsManager) ? FINGERS_ATTRIBUTION : null,
	};
}
