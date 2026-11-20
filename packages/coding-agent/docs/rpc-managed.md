# Managed RPC Mode

Managed mode is the RPC mode a host such as Veyra Hands uses to run Fingers inside a sandbox. It speaks the
Fingers RPC v1 contract, which lives in the `veyraco/platform` repository (`contracts/v1/fingers-rpc.md` with
its JSON Schemas and golden transcripts). This page describes what this Fingers version implements.

```bash
fingers --mode rpc --managed
```

`--managed` requires `--mode rpc`. Fingers then builds its session only after the host's `configure` command, so
no other CLI option selects the model, tools or working folder.

## What managed mode adds

| Area | Behaviour |
| --- | --- |
| Handshake | Fingers writes `hello` first (`protocol: veyra.fingers.rpc.v1`, `capabilities`). The first command must be `configure`; `credentials` must arrive before the first `prompt`. |
| Correlation | Every stdout record except a `response` carries `seq`, strictly increasing from 1. Every command should carry a W3C `traceparent`; a command without one starts a new trace and logs a warning. |
| Logs | stderr carries JSON log lines in the platform format (`service: "fingers"`, `run_id`, `request_id`, `trace_id`, `span_id`). Set the level with `FINGERS_LOG_LEVEL` and the `env` field with `FINGERS_ENV`. |
| Credentials | The model credential and every header value arrive only in `credentials` and `configure` (never argv or the environment), stay in memory, and are removed from every stdout record, log line and session file. |
| Policy | Extension, package, skill, prompt template and theme discovery are off; the project is never trusted; cache warming is off; only the built-in MCP extension is loaded. File tools may not leave `workspace.root` or touch `workspace.protected_paths` (symlinks resolved, path spellings expanded as the tools expand them). Shell commands are left to the host sandbox. |
| Approvals | `tools.approval` (`never`, `write_tools`, `always`) and each MCP server's `approval` decide which calls send `approval_request`. The call waits for `approval_response`; `allow_always` adds the request's `allow_always_pattern` to this process's allow list. A denial reaches the agent as `Denied: <reason>`. |
| MCP | `configure.mcp_servers` are Streamable HTTP servers; their tools are declared directly as `mcp__<server>__<tool>`, limited to `allowed_tools` when given. |
| Usage | A `usage` record follows every model call, with the call's and the process' token counts and list-price cost (`cost_source: unknown` and one `cost_unknown` notice when the model has no price). |
| Files | A `file_changed` record follows every successful `edit` or `write` (shell commands are not tracked). |
| Limits | `max_cost_usd`, `max_output_tokens` and `max_turns` stop the run after the turn in which they are reached; `max_duration_ms` aborts at once. The run then ends with `notice` `limit_reached` and a `result` with `status: stopped`. |
| Result | A `result` record follows every `agent_settled`. |

## Not available yet

These parts of the contract are not announced in `capabilities` and are refused or ignored:
`checkpoint_export` and `checkpoint_import` (answered with `unsupported`), the memory relay, the telemetry relay
and sub-agents. Extension UI `notify` calls are not forwarded in managed mode.

## Contract copies

`packages/coding-agent/src/modes/rpc/managed/contract-schemas.ts` and `test/fixtures/fingers-rpc/` are copies of
the platform contract made by `scripts/sync-fingers-rpc-contract.mjs <platform checkout>`. The managed mode tests
check every stdout record against the schemas and replay the golden transcripts.
