# Changelog

## [Unreleased]

### Added

- First Veyra Fingers release.
- Saved credentials live in the OS keychain (macOS Keychain, Secret Service, Windows Credential Manager); an existing `auth.json` is moved there and deleted. `FINGERS_CREDENTIAL_STORE=file` keeps `auth.json`. Managed RPC mode never reads stored credentials.
- First-run provider list and local detection (environment keys, AWS profiles, gcloud application default credentials), and OpenAI-compatible endpoints saved with their key in the keychain.
- `fingers --mode rpc --managed`: managed RPC mode for hosts such as Veyra Hands (Fingers RPC v1): `hello`/`configure`/`credentials` handshake, `seq` and `traceparent` correlation, JSON logs on stderr, the managed path policy, approvals, MCP servers from `configure`, `usage`, `file_changed`, limits and `result` records. See [docs/rpc-managed.md](docs/rpc-managed.md).
