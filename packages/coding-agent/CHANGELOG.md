# Changelog

## [Unreleased]

### Added

- First Veyra Fingers release.
- Terminal screens from the Veyra canvas: the banner with the Fingers mark, the Veyra dark and light palettes for the `dark` and `light` themes, the status line (model, provider, tokens in/out, cost, cache, budget, and the Veyra account or "core only · not signed in") on its own background (`statusBarBg`) under a location line and the editor key hints, the slash menu in a "Commands" box with `ee` tags, and the first-run screen when no model is configured (sign in to Veyra, an API key for one of the first-version providers, or environment keys).
- Approvals in the interactive terminal: shell commands outside the allow list show the approval box (Yes / Yes, always allow / No, tell Fingers what to do instead). `approvals.commands: "never"` turns it off; `approvals.allow` adds prefixes.

### Removed

- The Pi easter eggs (`/arminsayshi`, the 3D logo) and the `ArminComponent` export.
- The status line shows the session's prompt-cache hit ratio as `cache NN%` (cache reads over all prompt tokens), replacing `CHNN.N%` (latest request only).
- Saved credentials live in the OS keychain (macOS Keychain, Secret Service, Windows Credential Manager); an existing `auth.json` is moved there and deleted. `FINGERS_CREDENTIAL_STORE=file` keeps `auth.json`. Managed RPC mode never reads stored credentials.
- First-run provider list and local detection (environment keys, AWS profiles, gcloud application default credentials), and OpenAI-compatible endpoints saved with their key in the keychain.
- `fingers --mode rpc --managed`: managed RPC mode for hosts such as Veyra Hands (Fingers RPC v1): `hello`/`configure`/`credentials` handshake, `seq` and `traceparent` correlation, JSON logs on stderr, the managed path policy, approvals, MCP servers from `configure`, `usage`, `file_changed`, limits and `result` records. See [docs/rpc-managed.md](docs/rpc-managed.md).
