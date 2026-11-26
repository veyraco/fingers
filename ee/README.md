# Fingers ee

This folder holds the parts of Veyra Fingers that are not MIT: the ee features, under the
[Veyra Fingers Enterprise License](LICENSE). Everything outside `ee/` is the MIT core.

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
(`diff-edit.ts`) (F14); staged pruning of old tool results and the compaction estimate (`context.ts`, F15);
cheaper-model routing of sub-tasks (`routing.ts`, F16: the rule per sub-task class, versioned as
`ROUTING_RULES_VERSION`; the core offers the candidates through `routeModel` and reports each routed sub-task
through `afterRoute`, today compaction summaries). The module
registers them with `host.registerToolHooks("token_saving", …)`; the core's built-in `edition` extension calls them on
each tool result, at the end of each turn (`contextEdits`, saved as context edits) and around each compaction
(`beforeCompact`, `afterCompact`) of the terminal app while token saving is on, and each saving goes to the core's
savings ledger through `host.recordSaving`. See `packages/coding-agent/docs/slash-commands.md`
("Token saving") for what the model gets.

## Brain memory

`src/brain/` (F20, Medium tier or higher): `provider.ts` is the core's memory provider interface
(`packages/coding-agent/src/core/memory/types.ts`) on Brain's public API (`api.veyra.so/brain/v1`) as the signed-in
person, with a token for Brain only from `host.veyraApi("brain")`. One memory per repository: the `project` subject
whose id is the repository (`github.com/acme/web`, from the `origin` remote, never with credentials), addressed as
`subject:project:<id>`, so Brain creates it on the first write and every member shares it; a read of a repository
Brain has no memory of yet is an empty answer. `index.ts` registers the provider with
`host.registerMemoryProvider("brain", …)` and handles `/memory` (status, `recall`, `remember`, `off`, `on`). The
core's built-in `memory` extension does the rest (task-start context, the `memory_recall` and `memory_remember` tools,
the outcome event at the end of a run). Managed RPC never loads it: there the core relays memory to the host.

## Layout and checks

- `src/index.ts`: the module the core loads (`apiVersion` 5, `matrixVersion`, `minimumTier`, `activate`). It only
  imports types from `@veyraco/fingers`.
- `test/`: run with `npm run test:ee` from the repository root.
- `scripts/build-ee.mjs` builds `src/index.ts` into `packages/coding-agent/dist/ee/index.js` with this `LICENSE`
  next to it. Without this folder the build skips it.
- `scripts/check-ee-boundary.mjs` (part of `npm run check`) fails when a file outside `ee/` imports from it.
- CI builds and tests the core once more with this folder deleted.
