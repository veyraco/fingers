# Veyra Fingers

Veyra Fingers is a coding agent for the terminal. It reads, edits and runs code
in your project with the model provider you choose, and it is the agent that
runs inside Veyra Hands sandboxes.

- Works with API keys and with subscription sign-ins of the supported providers.
- Interactive terminal mode, print/JSON mode for scripts, and an RPC mode that
  hosts such as the Hands runner drive over stdin/stdout.
- Extensions, skills, prompt templates and themes, shared as packages through
  npm or git.

## Getting started

Fingers needs Node.js 22.19 or newer.

```bash
npm install -g --ignore-scripts @veyraco/fingers
cd /path/to/project
fingers
```

Run `/login` inside Fingers to connect a provider, then give it a task.

The documentation lives in [`packages/coding-agent/docs`](packages/coding-agent/docs/index.md).

## Packages

| Package | Description |
| --- | --- |
| [@veyraco/fingers](packages/coding-agent) | The `fingers` command-line coding agent |
| [@veyraco/fingers-ai](packages/ai) | Unified multi-provider LLM API |
| [@veyraco/fingers-agent](packages/agent) | Agent runtime with tool calling and state management |
| [@veyraco/fingers-tui](packages/tui) | Terminal UI library with differential rendering |
| [@veyraco/fingers-mcp](packages/mcp) | Standalone Model Context Protocol client |
| [@veyraco/fingers-schema](packages/schema) | JSON Schema validation without eval (drafts 2020-12 and 7) |
| [@veyraco/fingers-telemetry](packages/telemetry) | Vendor-neutral telemetry contracts |
| [@veyraco/fingers-codemode](packages/codemode) | Sandboxed JavaScript execution that can only call injected tools |
| [@veyraco/fingers-evals](packages/evals) | Evaluation harness (private) |

## Development

```bash
npm ci --ignore-scripts   # install dependencies without lifecycle scripts
npm run build             # build all packages
npm run check             # lint, format and type check
npm run test:scripts      # repository script tests
./test.sh                 # package tests in an isolated home, without API keys
./fingers-test.sh         # run fingers from source
```

See [AGENTS.md](AGENTS.md) for the development rules and
[CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute.

## License

MIT. See [LICENSE](LICENSE).
