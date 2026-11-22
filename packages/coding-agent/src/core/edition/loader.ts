/**
 * Finds the ee module of this installation at run time. The core has no import of `ee/`: a build without the `ee/`
 * folder simply finds nothing and runs as core only.
 *
 * Where it looks, first match wins:
 * - a compiled binary: `ee/index.js` next to the executable;
 * - a source checkout (the package has `src/`): the repository's `ee/src/index.ts`;
 * - an installed package: `dist/ee/index.js` (scripts/build-ee.mjs puts it there with `dist/ee/LICENSE`).
 *
 * A module built for another contract version, or without the expected exports, is not used.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir, isBunBinary } from "../../config.ts";
import { EE_API_VERSION, type EeModule } from "./types.ts";

export interface EeLocation {
	packageDir: string;
	isBunBinary: boolean;
	execPath: string;
}

/** The files the loader tries, in order. */
export function eeModuleCandidates(location: EeLocation): string[] {
	if (location.isBunBinary) return [join(dirname(location.execPath), "ee", "index.js")];
	const candidates: string[] = [];
	if (existsSync(join(location.packageDir, "src"))) {
		candidates.push(join(location.packageDir, "..", "..", "ee", "src", "index.ts"));
	}
	candidates.push(join(location.packageDir, "dist", "ee", "index.js"));
	return candidates;
}

/** The module's exports as an EeModule, or undefined when they do not match this core's contract. */
export function asEeModule(exports: unknown): EeModule | undefined {
	const namespace = exports as Record<string, unknown> | undefined;
	const candidate = (
		namespace && typeof namespace.default === "object" && namespace.default !== null ? namespace.default : namespace
	) as Partial<EeModule> | undefined;
	if (!candidate || typeof candidate !== "object") return undefined;
	if (candidate.apiVersion !== EE_API_VERSION) return undefined;
	if (typeof candidate.matrixVersion !== "string") return undefined;
	if (typeof candidate.minimumTier !== "function" || typeof candidate.activate !== "function") return undefined;
	return candidate as EeModule;
}

/**
 * Import the first ee module found; undefined when there is none (core only) or it does not fit. This is the one
 * dynamic import AGENTS.md allows for: a static import would make the core depend on ee/.
 */
export async function loadEeModule(
	location: EeLocation = { packageDir: getPackageDir(), isBunBinary, execPath: process.execPath },
	importer: (url: string) => Promise<unknown> = (url) => import(url),
): Promise<EeModule | undefined> {
	for (const file of eeModuleCandidates(location)) {
		if (!existsSync(file)) continue;
		try {
			return asEeModule(await importer(pathToFileURL(file).href));
		} catch {
			return undefined;
		}
	}
	return undefined;
}
