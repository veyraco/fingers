# Telemetry

Fingers can describe what each run did as OpenTelemetry traces in the
[GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/). It sends nothing unless you
turn it on: with no destination configured it makes no span and no request.

## What a trace holds

Each run (a prompt until the agent settles) is one trace:

| Span | When | Attributes |
| --- | --- | --- |
| `invoke_agent fingers` | The run, start to end; parent of the others | `gen_ai.operation.name`, `gen_ai.agent.name`, `gen_ai.conversation.id` (the session id) |
| `chat <model>` | Each model call, including a call made again after a failure | `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.response.id`, `gen_ai.response.finish_reasons`, `gen_ai.usage.input_tokens` (cached tokens included), `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`; on a failure `error.type` (`rate_limited`, `overloaded`, `timeout`, `credentials`, `context_overflow`, `provider_error`); on a retry `veyra.retry.attempt` (the first call is attempt 1) and `veyra.retry.reason` |
| `execute_tool <tool>` | Each tool call | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type`; `error.type: tool_error` when it failed |
| `veyra.compaction` | Each compaction | `veyra.compaction.tokens_before`, `veyra.compaction.tokens_after` (when known) |

By default spans carry metadata only. With content capture on they also carry `gen_ai.input.messages`,
`gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`
(each at most 64 KiB; the oldest messages are left out first) and the provider's error text. Attributes named like
a credential are never sent, and credential-shaped text (provider API keys, GitHub, Slack, AWS and Google keys,
bearer tokens, JWTs, private keys) is replaced by `[redacted]` in every span.

## Your own collector

Point Fingers at any OTLP/HTTP endpoint (an OpenTelemetry Collector, Jaeger, Grafana Tempo, Honeycomb, Langfuse and
others that accept OTLP JSON):

```bash
export FINGERS_OTLP_ENDPOINT=http://localhost:4318        # spans go to /v1/traces
export FINGERS_OTLP_HEADERS="authorization=Bearer%20abc"  # optional, URL-encoded values
export FINGERS_OTLP_CAPTURE_CONTENT=1                     # optional: prompts and answers too
fingers
```

`FINGERS_OTLP_TRACES_ENDPOINT` takes the full traces URL instead. Spans are batched (every 5 seconds, 64 at a time,
at most 2,048 waiting) and each run's trace is sent when the run ends; a destination that is down or refuses never
slows or stops the session. This works in the terminal app, print and JSON modes, and needs no sign-in.

## Veyra Eyes

Signed in to Veyra with a tier that includes Eyes (Medium or higher), the terminal app also sends each run's trace
to Veyra Eyes, metadata only, with your token for Eyes. `/eyes` shows the status and links the last trace; see
[Eyes telemetry](slash-commands.md#eyes-telemetry).

## Managed RPC

In managed mode (`fingers --mode rpc --managed`, used by Veyra Hands) Fingers never sends telemetry itself and
ignores `FINGERS_OTLP_*`. With `configure.telemetry.mode: relay` each span goes to the host as a `telemetry_span`
record on the run's trace; see [Managed RPC Mode](rpc-managed.md).
