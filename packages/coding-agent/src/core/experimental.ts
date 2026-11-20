export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.FINGERS_EXPERIMENTAL === "1";
}
