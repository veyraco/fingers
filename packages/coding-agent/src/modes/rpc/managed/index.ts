/**
 * `fingers --mode rpc --managed`: managed RPC mode on the process' stdin, stdout and stderr.
 */
import { VERSION } from "../../../config.ts";
import { loadEeModule } from "../../../core/edition/loader.ts";
import { flushRawStdout, takeOverStdout, writeRawStdout } from "../../../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../../../utils/shell.ts";
import { attachJsonlLineReader } from "../jsonl.ts";
import { ManagedRpcServer } from "./managed-rpc-server.ts";
import { createManagedRuntimeFactory, type ManagedRuntimeOptions } from "./managed-runtime.ts";
import { managedSubagentEngine } from "./subagents.ts";

export { ManagedRpcServer, type ManagedRpcServerOptions, type ManagedRuntimeFactory } from "./managed-rpc-server.ts";
export { createManagedRuntimeFactory, type ManagedRuntimeOptions } from "./managed-runtime.ts";

function logLevel(): "debug" | "info" | "warn" | "error" {
	const value = process.env.FINGERS_LOG_LEVEL;
	return value === "debug" || value === "warn" || value === "error" ? value : "info";
}

export async function runManagedRpcMode(options: ManagedRuntimeOptions = {}): Promise<never> {
	takeOverStdout();
	// Sub-agents are the ee module's; a build without it announces none.
	const eeModule = await loadEeModule().catch(() => undefined);
	const server = new ManagedRpcServer({
		io: {
			writeStdout: (line) => writeRawStdout(line),
			writeStderr: (line) => {
				process.stderr.write(line);
			},
		},
		createRuntime: createManagedRuntimeFactory(options),
		version: VERSION,
		env: process.env.FINGERS_ENV ?? process.env.VEYRA_ENV ?? "local",
		logLevel: logLevel(),
		subagentEngine: (checkpointsOn) => managedSubagentEngine(eeModule, checkpointsOn),
	});

	let exiting = false;
	const exit = async (code: number, reason: string): Promise<void> => {
		if (exiting) return;
		exiting = true;
		await server.shutdown(reason);
		await flushRawStdout();
		process.exit(code);
	};

	let signals = 0;
	const onSignal = (code: number) => () => {
		signals++;
		killTrackedDetachedChildren();
		if (signals > 1) process.exit(code);
		void exit(code, "signal");
	};
	process.on("SIGTERM", onSignal(143));
	if (process.platform !== "win32") process.on("SIGHUP", onSignal(129));

	server.start();
	// Lines are handled in order of arrival; commands still run concurrently, as in Pi's RPC mode.
	attachJsonlLineReader(process.stdin, (line) => {
		void server.handleLine(line);
	});
	process.stdin.on("end", () => {
		void exit(0, "stdin closed");
	});
	return new Promise<never>(() => {});
}
