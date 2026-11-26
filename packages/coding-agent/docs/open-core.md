# Open core

Fingers is open core. Everything in this repository outside the `ee/` folder is the MIT core: a complete coding
agent you can use, change and redistribute, commercially too, with no Veyra account. The `ee/` folder holds the
features a Veyra organization gets on top of it, under the Veyra Fingers Enterprise License
([`ee/LICENSE`](https://github.com/veyraco/fingers/blob/main/ee/LICENSE)). The `ee/` code is public to read; using it needs a Veyra organization whose
tier includes the feature.

## The two licenses

| Part | Where | License |
| --- | --- | --- |
| Core | Everything outside `ee/`, including every published `@veyraco/fingers*` package's own code | MIT ([`LICENSE`](https://github.com/veyraco/fingers/blob/main/LICENSE)), with two copyright notices: Veyra's, and the one of the open-source coding agent Fingers started from |
| ee | `ee/`, built into `dist/ee/` of the `@veyraco/fingers` package with its `LICENSE` next to it | Veyra Fingers Enterprise License ([`ee/LICENSE`](https://github.com/veyraco/fingers/blob/main/ee/LICENSE)); the MIT grant does not cover it |

## What is in the core

- The agent loop, its tools (read, bash, edit, write, grep, find, ls and the others), approvals and the terminal app.
- Every model provider: API keys, subscription sign-ins, cloud credentials, local and compatible endpoints, and the
  OS keychain for what you save. See [Providers](providers.md).
- Provider prompt caching and compaction. See [Compaction](compaction.md).
- Sessions: resume, `/tree`, fork, clone, export and share. See [Sessions](sessions.md).
- Extensions, skills, prompt templates, themes, MCP servers and Fingers packages.
- Print, JSON and RPC modes, managed RPC mode for hosts such as Veyra Hands (including the memory and telemetry
  relays), and the [SDK](sdk.md).
- Signing in with a Veyra account: `fingers login`, `fingers whoami`, `fingers logout`, `/login`, `/org` and
  `/logout`. See [Veyra account commands](cli.md#veyra-account-commands).
- Task budgets (`/budget`) and the savings report (`/savings`) with the prompt-caching row. See
  [Budget](slash-commands.md#budget) and [Savings report](slash-commands.md#savings-report).
- The memory provider interface and the memory tools, which any provider can plug into.
- OpenTelemetry GenAI spans of each run and the OTLP exporter to any collector. See [Telemetry](telemetry.md).
- The `agents` tool and its child sessions, which an ee engine drives.

Nothing in the core calls Veyra unless you sign in.

## What is in ee

| Feature | What it adds | Lowest tier | Docs |
| --- | --- | --- | --- |
| Token saving | No duplicate reads, trimmed tool output, diff edits, staged pruning before compaction, the compaction estimate, cheaper-model routing of side work, and their rows in `/savings` | Low | [Token saving](slash-commands.md#token-saving) |
| Sub-agents | The engine behind the `agents` tool (own git worktrees, a dependency queue, merging, a cheaper model per sub-agent) and `/agents` | Medium | [Sub-agents](slash-commands.md#sub-agents) |
| Checkpoints | Local git checkpoints of sub-agents | Medium | Not built yet |
| Brain memory | Veyra Brain as the memory provider, one memory per repository, and `/memory` | Medium | [Brain memory](slash-commands.md#brain-memory) |
| Eyes telemetry | Each run's trace sent to Veyra Eyes, and `/eyes` | Medium | [Eyes telemetry](slash-commands.md#eyes-telemetry) |
| Organization hooks | Hooks and policies the organization sets for every Fingers session | High | Not built yet |

The tiers come from `ee/src/tier-matrix.ts` (version `2026-11-22.1`) and are placeholders until launch. Free includes
no ee feature.

## How an ee feature switches on

Fingers turns an ee feature on only when all of these hold:

1. the ee module is there (the `ee/` folder in a source checkout, or `dist/ee/` in the published package);
2. you are signed in with `fingers login` (or `/login`);
3. Veyra Connect confirmed your organization's tier and apps within the last 72 hours;
4. your organization has the Fingers app on in Connect;
5. your organization's tier includes the feature.

Otherwise Fingers is "core only": the status line says so, `fingers whoami` and `/org` say why, and an ee command
shows what it needs instead of running. Your work goes on with the core. Fingers checks with Connect when it starts,
after `/login` and `/org`, and every hour; see [Open core](slash-commands.md#open-core) in the slash command
reference for the details. Managed RPC, print and JSON modes keep ee off: there Fingers holds no Veyra token.

## The boundary

The core never imports `ee/`. It looks for the built ee module at run time
(`packages/coding-agent/src/core/edition/loader.ts`) and talks to it only through the contract in
`packages/coding-agent/src/core/edition/types.ts`. Three checks keep it that way:

- `npm run check:ee-boundary` (part of `npm run check`) fails when a file outside `ee/` imports from it;
- the build (`scripts/build-ee.mjs`) bundles `ee/` into `dist/ee/` and skips it when the folder is missing;
- CI builds and tests the core once more with `ee/` deleted.

So you can delete the folder, or build from a copy without it, and Fingers still builds and works as the MIT core.

## Contributing

Contributions to the core are welcome under the MIT license; see [CONTRIBUTING.md](https://github.com/veyraco/fingers/blob/main/CONTRIBUTING.md).
Changes to `ee/` are made by Veyra. [`ee/README.md`](https://github.com/veyraco/fingers/blob/main/ee/README.md) describes how the ee module is laid out.
