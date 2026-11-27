/**
 * The Fingers policy that applies to the signed-in person (decision 14: the Fingers tab of Connect's group editor),
 * read from Connect: `GET <api>/connect/v1/organizations/{org}/fingers-policy/mine` (platform connect.yaml
 * `getMyFingersPolicy`, Fingers `cli:use`, a person's Connect token). The answer is the organization's rules
 * (instructions and hooks) with the person's group's limits; `revision` is also its ETag, and a read with
 * `If-None-Match` answers 304 when nothing changed.
 *
 * This file only reads and checks the answer: hooks are data (a tool list, a glob, block or ask, a message), never
 * commands. The ee `org_hooks` feature applies them (ee/src/org-hooks). An answer that does not match the contract,
 * or names another organization, is refused as a whole, so a half-read policy is never applied.
 */
import type { EeFingersPolicy, EeOrgHook } from "../edition/types.ts";

/** Connect's answer is not a policy Fingers can apply. `message` is meant for the person; it never echoes values. */
export class FingersPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FingersPolicyError";
	}
}

const HOOK_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TOOL_NAME = /^(\*|[a-z][a-z0-9_.-]{0,63})$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Control characters except tab and line breaks (connect.yaml `FingersPolicyReplace.instructions`). */
const INSTRUCTION_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** Control and text-direction characters except tab and line breaks (connect.yaml `FingersHook.message`). */
const MESSAGE_CONTROLS =
	/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

export const MAX_INSTRUCTIONS = 20_000;
export const MAX_HOOKS = 50;

function fail(field: string): never {
	throw new FingersPolicyError(`Connect's Fingers policy is not readable (${field}).`);
}

function requiredString(value: Record<string, unknown>, field: string): string {
	const text = value[field];
	if (typeof text !== "string" || text.length === 0) fail(field);
	return text;
}

function stringList(
	value: unknown,
	field: string,
	limits: { min: number; max: number; pattern: RegExp },
): string[] | null {
	if (value === null) return null;
	if (!Array.isArray(value) || value.length < limits.min || value.length > limits.max) fail(field);
	const items: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !limits.pattern.test(item) || items.includes(item)) fail(field);
		items.push(item);
	}
	return items;
}

function parseHook(entry: unknown, index: number, seen: Set<string>): EeOrgHook | undefined {
	const field = `hooks[${index}]`;
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) fail(field);
	const value = entry as Record<string, unknown>;
	const id = value.id;
	if (typeof id !== "string" || !HOOK_ID.test(id) || seen.has(id)) fail(`${field}.id`);
	seen.add(id);
	// Later contract versions may add events; a hook for another event does not apply to tool calls.
	if (typeof value.event !== "string") fail(`${field}.event`);
	const tools = stringList(value.tools, `${field}.tools`, { min: 1, max: 20, pattern: TOOL_NAME });
	if (tools === null) fail(`${field}.tools`);
	const pattern = value.pattern;
	if (pattern !== null && (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 500)) {
		fail(`${field}.pattern`);
	}
	const decision = value.decision;
	if (decision !== "block" && decision !== "ask") fail(`${field}.decision`);
	const message = value.message;
	if (typeof message !== "string" || message.length === 0 || message.length > 500 || MESSAGE_CONTROLS.test(message)) {
		fail(`${field}.message`);
	}
	if (value.event !== "before_tool_call") return undefined;
	return { id, event: "before_tool_call", tools, pattern, decision, message };
}

/**
 * Connect's `FingersEffectivePolicy` for the signed-in organization `org`. Throws FingersPolicyError when the answer
 * does not match the contract or is for another organization.
 */
export function parseFingersPolicy(body: unknown, org: string): EeFingersPolicy {
	if (typeof body !== "object" || body === null || Array.isArray(body)) fail("body");
	const value = body as Record<string, unknown>;
	const orgId = requiredString(value, "org_id");
	if (orgId !== org) fail("org_id");
	const groupId = requiredString(value, "group_id");
	const revision = requiredString(value, "revision");
	const instructions = value.instructions;
	if (
		typeof instructions !== "string" ||
		instructions.length > MAX_INSTRUCTIONS ||
		INSTRUCTION_CONTROLS.test(instructions)
	) {
		fail("instructions");
	}
	if (!Array.isArray(value.hooks) || value.hooks.length > MAX_HOOKS) fail("hooks");
	const seen = new Set<string>();
	const hooks: EeOrgHook[] = [];
	value.hooks.forEach((entry, index) => {
		const hook = parseHook(entry, index, seen);
		if (hook) hooks.push(hook);
	});
	const allowedProviders = stringList(value.allowed_providers, "allowed_providers", {
		min: 1,
		max: 20,
		pattern: PROVIDER_ID,
	});
	const allowedModels = stringList(value.allowed_models, "allowed_models", { min: 1, max: 200, pattern: MODEL_ID });
	const budget = value.default_task_budget_usd;
	if (budget !== null && (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0 || budget > 100_000)) {
		fail("default_task_budget_usd");
	}
	return {
		org: orgId,
		groupId,
		revision,
		instructions,
		hooks,
		allowedProviders,
		allowedModels,
		defaultTaskBudgetUsd: budget,
	};
}

/** The `If-None-Match` value for a revision Connect gave (its ETag is the revision, quoted). */
export function revisionEtag(revision: string): string {
	return `"${revision.replace(/["\\]/g, "")}"`;
}
