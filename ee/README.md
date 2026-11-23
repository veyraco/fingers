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

## Layout and checks

- `src/index.ts`: the module the core loads (`apiVersion`, `matrixVersion`, `minimumTier`, `activate`). It only
  imports types from `@veyraco/fingers`.
- `test/`: run with `npm run test:ee` from the repository root.
- `scripts/build-ee.mjs` builds `src/index.ts` into `packages/coding-agent/dist/ee/index.js` with this `LICENSE`
  next to it. Without this folder the build skips it.
- `scripts/check-ee-boundary.mjs` (part of `npm run check`) fails when a file outside `ee/` imports from it.
- CI builds and tests the core once more with this folder deleted.
