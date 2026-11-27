# Fingers ee

This folder holds the parts of Veyra Fingers that are not MIT: the ee features, under the
[Veyra Fingers Enterprise License](LICENSE). Everything outside `ee/` is the MIT core. What is in each part, for
readers: [Open core](../packages/coding-agent/docs/open-core.md).

## How ee features switch on

The core never imports this folder. At start it looks for the ee module
(`packages/coding-agent/src/core/edition/loader.ts`) and turns a feature on only when all of these hold:

1. the ee module is there (this folder, or `dist/ee/` in a published package);
2. you are signed in with `fingers login`;
3. Veyra Connect confirmed your organization's tier and apps within the last 72 hours (Fingers keeps Connect's
   last answer in your OS keychain, so a laptop can stay offline for up to three days);
4. your organization has the Fingers app on in Connect;
5. your organization's tier includes the feature.

Otherwise Fingers is "core only": the status line says so, and an ee command such as `/agents` shows why it is
locked instead of running.

## Tier matrix

`src/tier-matrix.ts`, version `2026-11-22.1`. The numbers are placeholders until launch.

| Feature | Lowest tier |
| --- | --- |
| Token saving | Low |
| Sub-agents | Medium |
| Checkpoints | Medium |
| Brain memory | Medium |
| Eyes telemetry | Medium |
| Organization hooks | High |

Free includes no ee feature, matching Connect's tier catalog (`fingers.ee` is off on Free).

## Token saving

`src/token-saving/`: no duplicate reads (`read-cache.ts`), trimmed shell output (`trim.ts`) and diff edits
(`diff-edit.ts`); staged pruning of old tool results and the compaction estimate (`context.ts`);
cheaper-model routing of sub-tasks (`routing.ts`: the rule per sub-task class, versioned as
`ROUTING_RULES_VERSION`; the core offers the candidates through `routeModel` and reports each routed sub-task
through `afterRoute`, today compaction summaries). The module
registers them with `host.registerToolHooks("token_saving", …)`; the core's built-in `edition` extension calls them on
each tool result, at the end of each turn (`contextEdits`, saved as context edits) and around each compaction
(`beforeCompact`, `afterCompact`) of the terminal app while token saving is on, and each saving goes to the core's
savings ledger through `host.recordSaving`. See `packages/coding-agent/docs/slash-commands.md`
("Token saving") for what the model gets.

## Sub-agents

`src/subagents/` (Medium tier or higher): `engine.ts` runs the children of one `agents` call (ids `sub_<n>`,
dependency queue, at most 4 at once, the budget and the parent's abort stop them, `steer`/`stop`/`list`), `git.ts`
gives each child a detached worktree under `.fingers/worktrees/<id>` at a snapshot of the parent's working tree (a
temporary index; never the parent's index, branch or stash; no hooks, no signing) and applies a finished child's
binary patch to the working tree. `index.ts` registers the engine with `host.registerSubagentEngine("subagents", …)`
and handles `/agents` (list, `steer <id> <message>`, `stop <id>`). The core's built-in `subagents` extension offers
the `agents` tool, makes the child sessions (`packages/coding-agent/src/extensions/subagents/child-session.ts`: the
parent's model runtime and settings, approvals asked in the parent's terminal) and picks each child's model through
the token-saving routing hooks. Lifecycle events follow Fingers RPC v1 (`subagent_started`, `subagent_updated`,
`subagent_finished`). Managed RPC activates this module with only `subagents` (and `checkpoints` while the
run configured them) on when the host sends `configure.subagents.enabled`; the core then runs the children under the
managed gate and forwards their records with their `agent_id` (`packages/coding-agent/docs/rpc-managed.md`).

The `/agents` panel is the core's (`packages/coding-agent/src/modes/interactive/components/agents-panel.ts`);
`/agents` opens it through `openAgentsPanel` in the command context. The engine adds `pause`/`resume` (the child
holds before its next model call), `checkpoint` (a commit of the child's worktree from `git.ts` `snapshot`, plus the
point of its transcript where it waits before a model call; at most 20 per child, kept in this process, no ref points
to them), `resume(id, checkpoint)` (the worktree reset to that commit with `git.ts` `restore`, the transcript taken
back there, and the child goes on with a note), `transcript` and `removeWorktree` (a kept worktree). Checkpoints are
their own feature: `index.ts` sets the engine's gate to `host.isOn("checkpoints")`.

## Brain memory

`src/brain/` (Medium tier or higher): `provider.ts` is the core's memory provider interface
(`packages/coding-agent/src/core/memory/types.ts`) on Brain's public API (`api.veyra.so/brain/v1`) as the signed-in
person, with a token for Brain only from `host.veyraApi("brain")`. One memory per repository: the `project` subject
whose id is the repository (`github.com/acme/web`, from the `origin` remote, never with credentials), addressed as
`subject:project:<id>`, so Brain creates it on the first write and every member shares it; a read of a repository
Brain has no memory of yet is an empty answer. `index.ts` registers the provider with
`host.registerMemoryProvider("brain", …)` and handles `/memory` (status, `recall`, `remember`, `off`, `on`). The
core's built-in `memory` extension does the rest (task-start context, the `memory_recall` and `memory_remember` tools,
the outcome event at the end of a run). Managed RPC never loads it: there the core relays memory to the host.
A provider belongs to the organization signed in when it was made (`host.veyraApi("brain").org`): its `key` is
`<org_id>:<repository>`, the core reuses kept memory only for the same key and keeps other keys' memory out of model
requests, and the provider refuses every call (`org_changed`) once the sign-in moved to another organization.

## Eyes telemetry

`src/eyes/` (Medium tier or higher): registers a span exporter with `host.registerTelemetryExporter("eyes", …)`;
the core's built-in `telemetry` extension sends it the spans of the terminal app's runs (GenAI `chat`,
`execute_tool` and `invoke_agent` spans, metadata only). It sends them with the core's OTLP exporter
(`host.createOtlpExporter`) to `<api>/eyes/otlp/v1/traces` with the person's token for Eyes
(`host.veyraApi("eyes")`), as an ordinary OTLP source (`service.name = fingers`, no `veyra.app`: a person's token is
not a feed, platform `contracts/v1/eyes-feed.md`). One exporter per organization; a batch is dropped instead of sent
once the sign-in moved to another organization, also when the switch lands while the token is fetched. `/eyes`
shows the status and the console link of the last run's trace (`eyes.<domain>/<org code>/traces/<trace id>`,
from `api.<domain>` and `host.veyraApi("eyes").orgCode`), `/eyes open` prints it, `/eyes off` and `/eyes on` stop
and resume sending. Managed RPC never loads it: there the core relays spans to the host (`telemetry_span`).

## Layout and checks

- `src/index.ts`: the module the core loads (`apiVersion` 8, `matrixVersion`, `minimumTier`, `activate`). It only
  imports types from `@veyraco/fingers`.
- `test/`: run with `npm run test:ee` from the repository root.
- `scripts/build-ee.mjs` builds `src/index.ts` into `packages/coding-agent/dist/ee/index.js` with this `LICENSE`
  next to it. Without this folder the build skips it.
- `scripts/check-ee-boundary.mjs` (part of `npm run check`) fails when a file outside `ee/` imports from it.
- CI builds and tests the core once more with this folder deleted.
