/**
 * The built-in `browser` tool (Fingers RPC v1 "Browser tool"; Hands `RunTool.builtin` name `browser`):
 * one headless Chromium per session, started on the first call and stopped at session shutdown. Every
 * request of the browser goes through the filtering proxy that applies `configure.network`
 * (core/browser). Managed mode loads it when `tools.builtin` names `browser`; the terminal does not load
 * it yet.
 */
import type { ImageContent, TextContent } from "@veyraco/fingers-ai";
import { Type } from "typebox";
import { type ActionReport, BrowserSession, type BrowserSessionOptions } from "../../core/browser/browser-session.ts";
import type { BlockedRequest } from "../../core/browser/filter-proxy.ts";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "../../core/extensions/types.ts";

export const BROWSER_TOOL_NAME = "browser";

/** Actions that can make the browser reach the network (approval kind `network`). */
export const BROWSER_NETWORK_ACTIONS: ReadonlySet<string> = new Set(["navigate", "click", "type", "evaluate"]);

const parameters = Type.Object({
	action: Type.Union(
		[
			Type.Literal("navigate"),
			Type.Literal("text"),
			Type.Literal("screenshot"),
			Type.Literal("click"),
			Type.Literal("type"),
			Type.Literal("evaluate"),
			Type.Literal("close"),
		],
		{ description: "What to do." },
	),
	url: Type.Optional(Type.String({ description: "navigate: the http(s) URL to open." })),
	selector: Type.Optional(Type.String({ description: "click, type: a CSS selector of the element." })),
	text: Type.Optional(Type.String({ description: "type: the text to type into the element." })),
	submit: Type.Optional(Type.Boolean({ description: "type: press Enter after typing." })),
	expression: Type.Optional(
		Type.String({ description: "evaluate: a JavaScript expression run in the page; its JSON value is returned." }),
	),
});

type BrowserParams = {
	action: "navigate" | "text" | "screenshot" | "click" | "type" | "evaluate" | "close";
	url?: string;
	selector?: string;
	text?: string;
	submit?: boolean;
	expression?: string;
};

export interface BrowserToolDetails {
	action: string;
	url?: string;
	blocked?: Array<{ host: string; port: number; reason: string }>;
}

function blockedLines(blocked: BlockedRequest[]): string[] {
	if (blocked.length === 0) return [];
	const seen = new Map<string, string>();
	for (const entry of blocked) seen.set(`${entry.host}:${entry.port}`, entry.reason);
	return [
		"",
		"Blocked by the run's network policy:",
		...[...seen].slice(0, 20).map(([target, reason]) => `- ${target} (${reason})`),
	];
}

function required(value: string | undefined, name: string, action: string): string {
	if (value === undefined || value === "") throw new Error(`browser ${action} needs \`${name}\``);
	return value;
}

function stringify(value: unknown): string {
	if (value === undefined) return "undefined";
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function result(
	action: string,
	report: ActionReport | undefined,
	lines: string[],
	image?: ImageContent,
): { content: (TextContent | ImageContent)[]; details: BrowserToolDetails } {
	const blocked = report?.blocked ?? [];
	const text = [...lines, ...blockedLines(blocked)].join("\n");
	return {
		content: image ? [image, { type: "text", text }] : [{ type: "text", text }],
		details: {
			action,
			...(report ? { url: report.url } : {}),
			...(blocked.length > 0 ? { blocked: blocked.map(({ host, port, reason }) => ({ host, port, reason })) } : {}),
		},
	};
}

const MAX_VALUE_CHARS = 20_000;

/** The tool definition, bound to one browser session. */
export function createBrowserToolDefinition(
	session: BrowserSession,
): ToolDefinition<typeof parameters, BrowserToolDetails> {
	return {
		name: BROWSER_TOOL_NAME,
		label: "Browser",
		description:
			"A headless web browser. Actions: navigate (open an http(s) URL), text (title, URL, visible text and links of the current page), screenshot (PNG of the page), click (CSS selector), type (CSS selector, text, optional submit with Enter), evaluate (run a JavaScript expression in the page and return its JSON value), close. Hosts outside the run's network policy are blocked and listed in the result.",
		promptSnippet: "Open web pages in a headless browser, read them, click, type and run page scripts",
		parameters,
		executionMode: "sequential",
		async execute(_toolCallId, params: BrowserParams, signal) {
			const action = params.action;
			switch (action) {
				case "navigate": {
					const report = await session.navigate(required(params.url, "url", action), signal);
					const lines = report.error
						? [`Could not open ${params.url}: ${report.error}`, `Now at: ${report.url}`]
						: [`Opened ${report.url}`, `Title: ${report.title}`, "Use action text to read the page."];
					return result(action, report, lines);
				}
				case "text": {
					const page = await session.text();
					const lines = [`URL: ${page.url}`, `Title: ${page.title}`, "", page.text];
					if (page.truncated) lines.push("", "[page text truncated]");
					if (page.links.length > 0) {
						lines.push("", "Links:", ...page.links.map((link) => `- ${link.text || "(no text)"}: ${link.href}`));
					}
					return result(action, { url: page.url, title: page.title, blocked: [] }, lines);
				}
				case "screenshot": {
					const shot = await session.screenshot();
					return result(action, shot, [`Screenshot of ${shot.url}`], {
						type: "image",
						data: shot.data,
						mimeType: "image/png",
					});
				}
				case "click": {
					const report = await session.click(required(params.selector, "selector", action), signal);
					return result(action, report, [`Clicked ${params.selector}`, `Now at: ${report.url}`]);
				}
				case "type": {
					const report = await session.type(
						required(params.selector, "selector", action),
						params.text ?? "",
						params.submit === true,
						signal,
					);
					return result(action, report, [
						`Typed into ${params.selector}${params.submit ? " and pressed Enter" : ""}`,
						`Now at: ${report.url}`,
					]);
				}
				case "evaluate": {
					const outcome = await session.evaluate(required(params.expression, "expression", action), signal);
					let value = stringify(outcome.value);
					if (value.length > MAX_VALUE_CHARS) value = `${value.slice(0, MAX_VALUE_CHARS)}\n[value truncated]`;
					return result(action, outcome, [value, "", `Page: ${outcome.url}`]);
				}
				case "close": {
					await session.close();
					return result(action, undefined, ["Browser closed."]);
				}
				default:
					throw new Error(`Unknown browser action: ${String(action)}`);
			}
		},
	};
}

/** Extension factory: registers `browser` and closes the browser when the session shuts down. */
export function createBrowserExtension(options: BrowserSessionOptions = {}): ExtensionFactory {
	return (fingers: ExtensionAPI) => {
		const session = new BrowserSession(options);
		fingers.registerTool(createBrowserToolDefinition(session));
		fingers.on("session_shutdown", async () => {
			await session.close();
		});
	};
}
