# Contributing to Veyra Fingers

Thanks for your interest in Fingers.

- Open an issue before a larger change so we can agree on the approach.
- Keep pull requests focused: one change, with tests that prove it.
- Run `npm run check` and the tests of the packages you touched before you open
  a pull request (see [AGENTS.md](AGENTS.md) for the commands).
- Add an entry under `## [Unreleased]` in the `CHANGELOG.md` of each package you
  changed.
- Dependency and lockfile changes are reviewed like code: pin direct
  dependencies to exact versions and explain why a new one is needed.

By contributing you agree that your contribution is licensed under the MIT
license of this repository.

## Releases

Maintainers release from `main`:

1. `npm run release:patch` (or `release:minor`, `release:major`, `release:<x.y.z>`)
   bumps every public package in lockstep, dates the changelogs, runs the checks
   and tests, commits, tags `vX.Y.Z` and pushes both.
2. The tag starts [`.github/workflows/release.yml`](.github/workflows/release.yml).
   It packs the packages once, checks the tarballs
   (`node scripts/check-package-tarballs.mjs`: the license in every package, no
   source maps, tests or local files) and then, from those same tarballs:
   - publishes `@veyraco/fingers*` to npm with provenance (`latest`, or `next`
     for a prerelease tag such as `v0.2.0-next.1`);
   - builds `ghcr.io/veyraco/fingers:<version>` for linux/amd64 and linux/arm64
     ([`docker/fingers/Dockerfile`](docker/fingers/Dockerfile): uid 1000,
     `/workspace`, git, ripgrep and fd), runs `fingers --version` in both and
     pushes; the job summary shows the digest to pin;
   - builds the standalone binaries (`scripts/build-binaries.sh`) and attaches
     them with `SHA256SUMS` to the GitHub release.

Run the workflow by hand (Actions → Release → Run workflow) on a tag or branch
for a dry run: everything runs, nothing is published. A push to `main`
publishes a prerelease `X.Y.Z-next.<run>` under `next` only while the
repository variable `FINGERS_PRERELEASE_ON_MAIN` is `true`.

The workflow needs the repository secret `NPM_TOKEN` (an automation token of
the `@veyraco` npm org). The first image push creates the GHCR package; make it
public in its package settings.
