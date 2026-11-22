import { type ChildProcess, spawn } from "node:child_process";

/**
 * Open a URL or file in the platform browser/default handler.
 *
 * This intentionally never invokes a shell. On Windows, do not use
 * `cmd /c start`: cmd.exe re-parses metacharacters (&, |, ^, ...) before
 * `start` runs, which would make attacker-controlled URLs injectable.
 */
export function openBrowser(target: string, options: { onError?: () => void } = {}): void {
	spawnOpener(target).on("error", () => options.onError?.());
}

/** Like openBrowser; resolves true once the launcher started, false when it could not be started at all. */
export function launchBrowser(target: string): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawnOpener(target);
		child.once("spawn", () => resolve(true));
		child.once("error", () => resolve(false));
	});
}

function spawnOpener(target: string): ChildProcess {
	const [cmd, args]: [string, string[]] =
		process.platform === "darwin"
			? ["open", [target]]
			: process.platform === "win32"
				? ["rundll32", ["url.dll,FileProtocolHandler", target]]
				: ["xdg-open", [target]];

	// spawn reports launcher failures (for example, missing xdg-open) via an
	// error event. Browser launch is best-effort: callers still present the target
	// to the user, so keep the launcher failure from becoming a process crash.
	// On WSL, xdg-open launches explorer.exe, which fails when the cwd's
	// \\wsl.localhost\... path exceeds MAX_PATH (#11592). The target is a URL,
	// so no launcher needs fingers' cwd.
	const child = spawn(cmd, args, { stdio: "ignore", detached: true, cwd: "/" });
	child.unref();
	return child;
}

/**
 * Whether a browser Fingers opens would appear in front of the person: not over SSH (it would open on the remote
 * computer, if at all) and, on Linux, only with a display. Callers that cannot open one show the address instead of
 * saying the browser opened.
 */
export function browserIsLocal(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
	if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.WSL_DISTRO_NAME && !env.TERMUX_VERSION) {
		return false;
	}
	return true;
}
