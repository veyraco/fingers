import { readFileSync } from "node:fs";
import { stripBom } from "../utils/text.ts";

export interface FingersManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
	changelogPath?: string;
}

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readFingersManifest(packageJsonPath: string): FingersManifest | null {
	try {
		const pkg: unknown = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8")));
		if (!isObject(pkg) || !isObject(pkg.fingers)) {
			return null;
		}

		const manifest: FingersManifest = {};
		for (const field of RESOURCE_FIELDS) {
			const entries = pkg.fingers[field];
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
				manifest[field] = entries;
			}
		}

		const changelogPath = pkg.fingers.changelogPath;
		if (typeof changelogPath === "string") {
			manifest.changelogPath = changelogPath;
		}

		return manifest;
	} catch {
		return null;
	}
}
