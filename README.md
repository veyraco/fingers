<p align="center">
  <img src=".github/banner-light.png#gh-light-mode-only" width="100%" alt="Veyra Fingers: The coding-agent harness for every model provider.">
  <img src=".github/banner-dark.png#gh-dark-mode-only" width="100%" alt="Veyra Fingers: The coding-agent harness for every model provider.">
</p>

<p align="center">
  <a href="https://docs.veyra.so/en/fingers/"><img src="https://img.shields.io/badge/docs-docs.veyra.so-188038" alt="Docs: docs.veyra.so/en/fingers"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-5F6368" alt="License: MIT"></a>
  <a href="https://veyra.so"><img src="https://img.shields.io/badge/Veyra-family-C5221F" alt="Part of the Veyra family"></a>
</p>

<p align="center">
  <a href="https://docs.veyra.so/en/fingers/">Docs</a> ·
  <a href="https://veyra.so/fingers">veyra.so/fingers</a>
</p>

## What it is

Veyra Fingers is a coding agent for the terminal. It reads, edits and runs code
in your project with the model provider you choose, and it is the agent that
runs inside Veyra Hands sandboxes.

- Works with API keys and with subscription sign-ins of the supported providers.
- Interactive terminal mode, print/JSON mode for scripts, and an RPC mode that
  hosts such as the Hands runner drive over stdin/stdout.
- Extensions, skills, prompt templates and themes, shared as packages through
  npm or git.

## How it fits the Veyra family

|   | Product | With Fingers |
| --- | --- | --- |
| <img src=".github/marks/intelligence-light.svg#gh-light-mode-only" width="20" alt="Veyra Intelligence"><img src=".github/marks/intelligence-dark.svg#gh-dark-mode-only" width="20" alt="Veyra Intelligence"> | [Intelligence](https://veyra.so/intelligence) | The AI workspace where a company is run by AI agents. |
| <img src=".github/marks/brain-light.svg#gh-light-mode-only" width="20" alt="Veyra Brain"><img src=".github/marks/brain-dark.svg#gh-dark-mode-only" width="20" alt="Veyra Brain"> | [Brain](https://veyra.so/brain) | Memory for any AI: short and long term, live learning. |
| <img src=".github/marks/eyes-light.svg#gh-light-mode-only" width="20" alt="Veyra Eyes"><img src=".github/marks/eyes-dark.svg#gh-dark-mode-only" width="20" alt="Veyra Eyes"> | [Eyes](https://veyra.so/eyes) | AI observability that reads what models see and say. |
| <img src=".github/marks/hands-light.svg#gh-light-mode-only" width="20" alt="Veyra Hands"><img src=".github/marks/hands-dark.svg#gh-dark-mode-only" width="20" alt="Veyra Hands"> | [Hands](https://veyra.so/hands) | AI sandboxes and the AI runner. |
| <img src=".github/marks/fingers-light.svg#gh-light-mode-only" width="20" alt="Veyra Fingers"><img src=".github/marks/fingers-dark.svg#gh-dark-mode-only" width="20" alt="Veyra Fingers"> | **Fingers** | This repository. |
| <img src=".github/marks/connect-light.svg#gh-light-mode-only" width="20" alt="Veyra Connect"><img src=".github/marks/connect-dark.svg#gh-dark-mode-only" width="20" alt="Veyra Connect"> | [Connect](https://connect.veyra.so) | Sign-in, organizations, API keys and billing for every app. |

## Quick start

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

The core is MIT. See [LICENSE](LICENSE). The `ee/` folder holds Fingers ee under the Veyra Fingers Enterprise License ([ee/LICENSE](ee/LICENSE)): its features switch on after `fingers login` when your organization's Veyra tier includes them, and the core runs without it. [Open core](packages/coding-agent/docs/open-core.md) lists what is in each part; [ee/README.md](ee/README.md) describes the ee module.

## Links

- Docs: https://docs.veyra.so/en/fingers/
- Docs in this repository: [packages/coding-agent/docs](packages/coding-agent/docs/index.md)
- Product page: https://veyra.so/fingers
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)

<p align="center"><sub>Part of the Veyra family · <a href="https://veyra.so">veyra.so</a> · Sign in with Veyra Connect</sub></p>
