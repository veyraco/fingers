# Changelog

## [Unreleased]

### Added

- First Veyra Fingers release.
- `fingers --mode rpc --managed`: managed RPC mode for hosts such as Veyra Hands (Fingers RPC v1): `hello`/`configure`/`credentials` handshake, `seq` and `traceparent` correlation, JSON logs on stderr, the managed path policy, approvals, MCP servers from `configure`, `usage`, `file_changed`, limits and `result` records. See [docs/rpc-managed.md](docs/rpc-managed.md).
