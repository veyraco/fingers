/**
 * `fingers --hands` (F13b): the terminal side of a Hands-backed session. Reads the prompt, wires the terminal's lines
 * and stop keys to the session, and runs it (hands-session.ts).
 */
import { createInterface } from "node:readline";
import type { Args } from "../../cli/args.ts";
import { type HandsSessionAuth, HandsSessionError, LineQueue, runHandsSession } from "./hands-session.ts";

export { chooseModel, HandsSessionError, LineQueue, runHandsSession } from "./hands-session.ts";

/** Why `--hands` can't be used with the other arguments, or undefined when it can. */
export function handsArgsProblem(parsed: Args): string | undefined {
	if (parsed.local) return "--hands and --local exclude each other";
	if (parsed.mode === "rpc" || parsed.managed) return "--hands can't be used with --mode rpc or --managed";
	if (parsed.continue || parsed.resume || parsed.session || parsed.sessionId || parsed.fork) {
		return "--hands starts a new session in Hands; --continue, --resume, --session, --session-id and --fork are for local sessions";
	}
	if (parsed.fileArgs.length > 0) {
		return "@file arguments are not used with --hands: the workspace goes up with the session, so name the file in the prompt";
	}
	return undefined;
}

/** Whether the `hands.default` setting starts this invocation in Hands (never over flags that mean a local session). */
export function handsByDefault(parsed: Args, handsDefault: boolean | undefined): boolean {
	if (handsDefault !== true || parsed.local) return false;
	if (parsed.help || parsed.version || parsed.listModels !== undefined || parsed.export) return false;
	return handsArgsProblem({ ...parsed, local: false }) === undefined;
}

export interface HandsModeOptions {
	parsed: Args;
	auth: HandsSessionAuth;
	cwd: string;
	defaultProvider?: string;
	defaultModel?: string;
	sizeSetting?: string;
	/** Piped standard input, added to the prompt. */
	stdinContent?: string;
}

/** Runs `fingers --hands`; returns the exit code. */
export async function runHandsMode(options: HandsModeOptions): Promise<number> {
	const { parsed } = options;
	const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true && !parsed.print && !parsed.mode;
	const output = parsed.mode === "json" ? "json" : "text";
	const write = (text: string) => {
		process.stdout.write(text);
	};

	const queue = new LineQueue();
	const rl = interactive ? createInterface({ input: process.stdin, terminal: false }) : undefined;
	rl?.on("line", (line) => queue.push(line));
	rl?.on("close", () => queue.close());

	const handlers = new Set<() => void>();
	let stoppedEarly = false;
	const onSignal = () => {
		// Before the session runs (the prompt is being typed) a stop just ends Fingers.
		if (handlers.size === 0) {
			stoppedEarly = true;
			queue.close();
			return;
		}
		for (const handler of handlers) handler();
	};
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, onSignal);

	try {
		let prompt = [...parsed.messages, ...(options.stdinContent ? [options.stdinContent] : [])].join("\n\n").trim();
		if (!prompt && interactive) {
			write("What should the agent do in Hands?\n");
			prompt = (await queue.next())?.trim() ?? "";
		}
		if (stoppedEarly) return 130;
		if (!prompt) {
			const message = new HandsSessionError('Give the task: fingers --hands "what to do".').message;
			process.stderr.write(`${message}\n`);
			return 1;
		}
		const result = await runHandsSession({
			auth: options.auth,
			cwd: options.cwd,
			prompt,
			output,
			write,
			interactive,
			input: interactive ? queue : undefined,
			provider: parsed.provider,
			model: parsed.model,
			defaultProvider: options.defaultProvider,
			defaultModel: options.defaultModel,
			size: parsed.handsSize ?? options.sizeSetting,
			onInterrupt: (handler) => {
				handlers.add(handler);
				return () => handlers.delete(handler);
			},
		});
		return result.exitCode;
	} finally {
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, onSignal);
		rl?.close();
	}
}
