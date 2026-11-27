// Copyright (c) 2026 Veyra. Licensed under the Veyra Fingers Enterprise License (ee/LICENSE); not MIT.
/**
 * Organization hooks in the terminal app (decision 14: the Fingers tab of Connect's group editor; canvas
 * FingersTuiSlash `/hooks` "1 from org policy"). While the `org_hooks` feature is on (signed in, Fingers on for the
 * organization, a tier that includes it), Fingers reads the person's Fingers policy from Connect
 * (`GET <api>/connect/v1/organizations/{org}/fingers-policy/mine`, through the core, which keeps the token) and:
 *
 * - checks every tool call against the organization's hooks before it runs: the first hook whose tools include the
 *   call's tool and whose glob matches the call's whole subject (the command for bash and powershell, the path for
 *   file tools) decides, `block` (the call does not run) or `ask` (the person approves it first);
 * - adds the organization's rules (Markdown instructions) to the end of every run's system prompt;
 * - `/hooks` lists them, `/hooks refresh` reads them again.
 *
 * The policy is read again, with its revision (`If-None-Match`, a 304 when nothing changed), when the last read is
 * older than a minute and a tool call comes, and at every entitlement check. While no policy for the signed-in
 * organization could be read yet, every tool call asks the person first (fail closed). Hooks are data: Fingers never
 * runs anything a hook names. The group's model limits and task budget in the same policy are not applied here.
 */
import type {
	EeCommandContext,
	EeFingersPolicy,
	EeFingersPolicySource,
	EeHost,
	EeOrgHook,
	EeToolCall,
	EeToolCallDecision,
	EeToolHooks,
} from "@veyraco/fingers";

/** How old the last read may be before a tool call reads the policy again. */
export const POLICY_MAX_AGE_MS = 60_000;
/** How long a tool call waits for that read; on a timeout the call is checked against the policy read before. */
export const POLICY_READ_TIMEOUT_MS = 5_000;

const COMMAND_TOOLS = new Set(["bash", "powershell"]);

/**
 * Whether `glob` matches the whole of `subject` (connect.yaml `FingersHook.pattern`: `*` any run of characters, `?`
 * one character, everything else literal, case-sensitive). Linear in practice: one backtrack point (the last `*`).
 */
export function globMatches(glob: string, subject: string): boolean {
	const pattern = Array.from(glob);
	const text = Array.from(subject);
	let p = 0;
	let t = 0;
	let star = -1;
	let resume = 0;
	while (t < text.length) {
		if (p < pattern.length && (pattern[p] === "?" || (pattern[p] !== "*" && pattern[p] === text[t]))) {
			p++;
			t++;
		} else if (p < pattern.length && pattern[p] === "*") {
			star = p++;
			resume = t;
		} else if (star >= 0) {
			p = star + 1;
			t = ++resume;
		} else {
			return false;
		}
	}
	while (p < pattern.length && pattern[p] === "*") p++;
	return p === pattern.length;
}

/** `src/app.ts` for `/repo/src/app.ts` in `/repo`; undefined outside the working directory. */
function relativeToCwd(path: string, cwd: string): string | undefined {
	const base = cwd.replace(/[\\/]+$/, "");
	if (path === base) return ".";
	for (const separator of ["/", "\\"]) {
		if (path.startsWith(`${base}${separator}`)) return path.slice(base.length + 1);
	}
	return undefined;
}

/** What a hook's glob is matched against: the command, or the path (absolute, and relative to the working directory). */
export function callSubjects(call: EeToolCall): string[] {
	if (COMMAND_TOOLS.has(call.toolName)) {
		const command = call.input.command;
		return typeof command === "string" ? [command] : [];
	}
	if (!call.path) return [];
	const relative = relativeToCwd(call.path, call.cwd);
	return relative && relative !== call.path ? [call.path, relative] : [call.path];
}

/** The first hook of `hooks` that applies to `call`, or undefined. */
export function matchingHook(hooks: readonly EeOrgHook[], call: EeToolCall): EeOrgHook | undefined {
	let subjects: string[] | undefined;
	for (const hook of hooks) {
		if (hook.event !== "before_tool_call") continue;
		if (!hook.tools.includes("*") && !hook.tools.includes(call.toolName)) continue;
		if (hook.pattern === null) return hook;
		subjects ??= callSubjects(call);
		const pattern = hook.pattern;
		if (subjects.some((subject) => globMatches(pattern, subject))) return hook;
	}
	return undefined;
}

function oneLine(text: string, max = 120): string {
	const flat = text
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function errorText(error: unknown): string {
	return oneLine(error instanceof Error ? error.message : String(error), 200);
}

const USAGE = "Usage: /hooks, /hooks refresh";

export class OrgHooks {
	private source: EeFingersPolicySource | undefined;
	private policy: EeFingersPolicy | undefined;
	/** When the last read finished, successful or not (epoch ms); 0: never. */
	private checkedAt = 0;
	/** When a read last succeeded. */
	private readAt = 0;
	private lastError: string | undefined;
	private reading: Promise<void> | undefined;
	private readonly now: () => number;
	private readonly maxAgeMs: number;
	private readonly readTimeoutMs: number;

	constructor(options: { now?: () => number; maxAgeMs?: number; readTimeoutMs?: number } = {}) {
		this.now = options.now ?? Date.now;
		this.maxAgeMs = options.maxAgeMs ?? POLICY_MAX_AGE_MS;
		this.readTimeoutMs = options.readTimeoutMs ?? POLICY_READ_TIMEOUT_MS;
	}

	readonly hooks: EeToolHooks = {
		beforeToolCall: (call) => this.check(call),
		systemPrompt: () => this.rules(),
	};

	/** The feature is on: read the policy, check calls against it, add its rules, offer /hooks. */
	attach(host: EeHost): void {
		const source = host.fingersPolicy();
		if (source !== this.source) {
			this.source = source;
			this.checkedAt = 0;
		}
		host.registerToolHooks("org_hooks", this.hooks);
		host.registerCommand("hooks", (context) => this.command(context));
		void this.refresh();
	}

	/** The feature is off: forget the policy. */
	reset(): void {
		this.source = undefined;
		this.policy = undefined;
		this.checkedAt = 0;
		this.readAt = 0;
		this.lastError = undefined;
	}

	/** The policy of the signed-in organization, or undefined while none was read (or the sign-in moved). */
	current(): EeFingersPolicy | undefined {
		const policy = this.policy;
		const org = this.source?.org;
		return policy && org && policy.org === org ? policy : undefined;
	}

	/** Read the policy again (one read at a time); keeps the policy read before when the read fails. */
	refresh(): Promise<void> {
		this.reading ??= this.read().finally(() => {
			this.reading = undefined;
		});
		return this.reading;
	}

	private async read(): Promise<void> {
		const source = this.source;
		if (!source) return;
		const known = this.current();
		try {
			const answer = await source.read({ revision: known?.revision });
			if (source !== this.source) return;
			if (answer.changed) this.policy = answer.policy;
			else if (!known) throw new Error("Connect said the policy did not change, but none was read before.");
			this.readAt = this.now();
			this.lastError = undefined;
		} catch (error) {
			if (source === this.source) this.lastError = errorText(error);
		} finally {
			if (source === this.source) this.checkedAt = this.now();
		}
	}

	private async check(call: EeToolCall): Promise<EeToolCallDecision | undefined> {
		if (!this.source) return undefined;
		if (this.now() - this.checkedAt >= this.maxAgeMs || !this.current()) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<void>((resolve) => {
				timer = setTimeout(resolve, this.readTimeoutMs);
			});
			try {
				await Promise.race([this.refresh(), timeout]);
			} finally {
				clearTimeout(timer);
			}
		}
		const policy = this.current();
		if (!policy) {
			return {
				decision: "ask",
				message:
					"Fingers could not read your organization's hooks from Veyra Connect yet, so it asks before every tool call. /hooks shows why.",
				source: "organization policy",
			};
		}
		const hook = matchingHook(policy.hooks, call);
		if (!hook) return undefined;
		return { decision: hook.decision, message: hook.message, source: `organization hook “${hook.id}”` };
	}

	private rules(): string | undefined {
		const instructions = this.current()?.instructions.trim();
		if (!instructions) return undefined;
		return [
			"# Organization rules",
			"",
			"Your organization set these rules for every Fingers session in Veyra Connect. Follow them.",
			"",
			instructions,
		].join("\n");
	}

	private async command(context: EeCommandContext): Promise<void> {
		const args = context.args.trim();
		if (args === "refresh") {
			this.checkedAt = 0;
			await this.refresh();
		} else if (args) {
			context.showWarning(USAGE);
			return;
		}
		const policy = this.current();
		if (!policy) {
			context.showWarning(
				`No organization hooks yet: Fingers could not read your organization's policy from Veyra Connect${
					this.lastError ? ` (${this.lastError})` : ""
				}. Until it can, Fingers asks before every tool call. /hooks refresh tries again.`,
			);
			return;
		}
		const lines = [`Hooks · ${policy.hooks.length} from org policy`];
		for (const hook of policy.hooks) {
			const tools = hook.tools.join(", ");
			const pattern = hook.pattern === null ? "every call" : `“${oneLine(hook.pattern, 80)}”`;
			lines.push(`  ${hook.id} · ${hook.decision} · ${tools} · ${pattern} · ${oneLine(hook.message)}`);
		}
		const rules = policy.instructions.trim();
		lines.push(
			rules
				? `Organization rules: ${rules.length} characters, added to every run's instructions.`
				: "Organization rules: none.",
		);
		const age = Math.max(0, Math.round((this.now() - this.readAt) / 1000));
		lines.push(
			this.lastError
				? `Read ${age} s ago; the last read failed (${this.lastError}).`
				: `Read from Veyra Connect ${age} s ago.`,
		);
		context.showStatus(lines.join("\n"));
	}
}
