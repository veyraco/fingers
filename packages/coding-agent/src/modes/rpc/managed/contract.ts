/**
 * The Fingers RPC v1 contract (veyraco/platform contracts/v1/fingers-rpc.md) as this build implements it:
 * protocol id, capabilities and schema validation of the records on both sides of the pipe.
 */
import { compile, type JsonSchema, type Validator } from "@veyraco/fingers-schema";
import { formats } from "@veyraco/fingers-schema/formats";
import { commandSchema, commonSchema, eventSchema, responseSchema } from "./contract-schemas.ts";

export const FINGERS_RPC_PROTOCOL = "veyra.fingers.rpc.v1";

/**
 * Capabilities this build announces in `hello`. The telemetry relay and sub-agents are part of the contract but not
 * implemented yet; a host must not use them until they are announced.
 */
export const MANAGED_CAPABILITIES = [
	"approvals",
	"limits",
	"usage",
	"file_changes",
	"checkpoints",
	"mcp",
	"memory_relay",
] as const;

/** Commands of the contract (Pi-compatible plus Veyra additions). Anything else is `unknown_command`. */
export const CONTRACT_COMMANDS = new Set([
	"configure",
	"credentials",
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"clear_queue",
	"compact",
	"fork",
	"clone",
	"get_state",
	"get_messages",
	"get_last_assistant_text",
	"get_session_stats",
	"set_model",
	"set_thinking_level",
	"checkpoint_export",
	"checkpoint_import",
]);

/** Replies to Fingers' own requests: no `response` follows them. */
export const CONTRACT_REPLIES = new Set(["approval_response", "memory_response", "extension_ui_response"]);

export type ErrorCode =
	| "parse_error"
	| "unknown_command"
	| "invalid_command"
	| "not_configured"
	| "already_configured"
	| "credentials_missing"
	| "busy"
	| "not_found"
	| "checksum_mismatch"
	| "path_not_allowed"
	| "unsupported"
	| "internal";

let validators: { command: Validator; response: Validator; event: Validator } | undefined;

function getValidators() {
	if (validators) return validators;
	const schemas: Record<string, JsonSchema> = {};
	for (const schema of [commandSchema, responseSchema, eventSchema, commonSchema]) {
		schemas[(schema as { $id: string }).$id] = schema;
	}
	const options = { schemas, formats };
	validators = {
		command: compile(commandSchema, options),
		response: compile(responseSchema, options),
		event: compile(eventSchema, options),
	};
	return validators;
}

function describe(errors: ReadonlyArray<{ path: string; message: string }>): string {
	return errors
		.slice(0, 5)
		.map((error) => `${error.path || "/"}: ${error.message}`)
		.join("; ");
}

/** Validate a stdin record (a command or a reply) against the command schema. */
export function validateCommand(record: unknown): { ok: true } | { ok: false; message: string } {
	const validator = getValidators().command;
	if (validator.check(record)) return { ok: true };
	return { ok: false, message: describe(validator.errors(record)) };
}

/** Errors of a stdout record against the response or event schema; empty when it conforms. */
export function validateOutbound(record: Record<string, unknown>): string[] {
	const v = getValidators();
	const validator = record.type === "response" ? v.response : v.event;
	if (validator.check(record)) return [];
	return validator.errors(record).map((error) => `${error.path || "/"}: ${error.message}`);
}
