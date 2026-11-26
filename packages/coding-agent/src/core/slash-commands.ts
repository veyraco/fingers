import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
	/** `ee`: the command needs `fingers login` and a Veyra tier that includes it (tagged in the slash menu). */
	edition?: "ee";
}

/** The slash menu frame (canvas FingersTuiSlash): title, the `ee` legend, and the key hints below it. */
export const SLASH_MENU = {
	title: "Commands",
	tagLegends: { ee: "= needs fingers login and a Veyra tier that includes it" },
	hint: "↑↓ move · tab complete · enter run · esc close",
	selectedMarker: "❯ ",
	labelPrefix: "/",
} as const;

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
	// Canvas FingersTuiSlash: an ee feature (sub-agents). Locked until signed in with a tier that includes it.
	{ name: "agents", description: "sub-agents: start, watch, steer, stop", edition: "ee" },
	{ name: "budget", description: "set or view the task budget", argumentHint: "<dollars> | off" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "thinking", description: "Set thinking level", argumentHint: "<level>" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import a JSONL session, preserving its ID and working directory" },
	{ name: "share", description: "Share session as a GitHub gist" },
	{ name: "bug", description: "Save a bug report as a zip archive", argumentHint: "<description>" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	// Canvas FingersTuiSlash: /login is the Veyra sign-in; `/login <provider>` still configures a model provider.
	{ name: "login", description: "sign in to Veyra Connect (device code)", argumentHint: "[provider]" },
	{ name: "org", description: "Veyra organization, tier and group · switch by signing in again" },
	{ name: "logout", description: "sign out of Veyra (revokes the device) · /logout <provider>" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume another session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];
