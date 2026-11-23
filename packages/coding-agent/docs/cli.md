<a id="cli-and-modes-reference"></a>

# Command Line

This page documents Fingers' built-in command-line commands and options. Run `fingers --help` or append `--help` to a command for the exact interface in your installed version. The top-level help also includes options registered by loaded extensions.

```sh
fingers [options] [--] [@files...] [messages...]
fingers install <source> [options]
fingers remove <source> [options]
fingers uninstall <source> [options]
fingers update [target] [options]
fingers list
fingers config [options]
fingers login [--no-browser] [--connect <url>]
fingers whoami [--json] [--connect <url>]
fingers logout [--connect <url>]
fingers auth login <provider> [--api-key] [--no-browser]
fingers auth logout <provider>
fingers auth <check|print-api-key|print-bearer-token> [options]
fingers mcp <add|remove|list|login|logout> [options]
```

<a id="modes"></a>

## Invocation and output

```sh
fingers
fingers --print "Summarize this repository"
git diff | fingers --print "Review this change"
fingers --mode json "Inspect this repository" > events.jsonl
```

With terminal stdin and stdout, Fingers opens the terminal UI unless `--print`, `--mode json`, or `--mode rpc` selects another interface. When either stream is redirected and neither JSON nor RPC mode is selected, Fingers uses print mode. See [CLI Integration](cli-integration.md) for choosing between interactive, print, JSON, RPC, and SDK integration.

| Input | Behavior |
|---|---|
| `message` | Provide an initial prompt |
| `@path` | Include a text file or image in the first prompt |
| Piped stdin | Prepend its contents to the first prompt |
| `--` | Stop option parsing so a prompt can begin with `-` |

Fingers resolves `@path` from the current working directory. The working directory also controls project configuration, resource discovery, and session grouping.

`--print` controls whether Fingers runs once and exits. `--mode` selects the output interface. `--mode text` does not force one-shot execution when stdin and stdout are terminals; use `--print` for that behavior.

| Option | Behavior |
|---|---|
| `-p`, `--print` | Run the supplied prompts, write the final assistant text to stdout, then exit |
| `--mode text` | Select text output; still open the terminal UI when stdin and stdout are terminals |
| `--mode json` | Run the supplied prompts, write JSONL events to stdout, then exit |
| `--mode rpc` | Read JSONL commands from stdin and write responses and events to stdout until shutdown |
| `--export <input> [output]` | Export a session file to HTML and exit; derive the destination when `output` is omitted |

RPC mode rejects `@file` arguments. JSON and RPC modes reserve stdout for protocol records. See [JSON Event Stream](json.md) and [RPC Protocol](rpc.md).

<a id="model-options"></a>

## Models

```sh
fingers --model sonnet:high
```

See [Choose a Model](models.md) for model selection and [Providers](providers.md) for credentials.

- `--provider <name>`<br>
  Restricts `--model` lookup to one provider. It requires `--model`.
- `--model <pattern>`<br>
  Selects by exact ID or fuzzy ID/name match. It accepts `provider/id` and an optional `:<thinking>` suffix. If several providers match, Fingers prefers the one with credentials, otherwise it asks for `--provider`.
- `--api-key <key>`<br>
  Uses a non-persistent API-key override. It requires a model selected through `--model` or `--models`. It does not choose between providers that offer the same model.
- `--thinking <level>`<br>
  Sets `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. It overrides a `--model` suffix and is clamped to the model's capabilities.
- `--models <patterns>`<br>
  Sets a comma-separated scope for startup and cycling. It accepts exact IDs, fuzzy matches, case-insensitive globs, and optional `:<thinking>` suffixes. A model offered by several providers is added for each, with a warning.
- `--list-models [search]`<br>
  Lists available models, optionally filtered by a fuzzy search, then exits.

<a id="session-options"></a>

## Sessions

```sh
fingers --continue
```

See [Sessions and Context](sessions.md) for resuming, forking, naming, and storing sessions.

- `-c`, `--continue`<br>
  Continues the most recent session for the current directory.
- `-r`, `--resume`<br>
  Opens the session selector and resumes the chosen session in its working directory. Press Tab to include sessions from other directories.
- `--session <path|id>`<br>
  Opens a session by file path or full/partial ID, and resumes it in its working directory. If the ID only matches sessions stored for another directory, Fingers offers to fork it into the current directory instead.
- `--session-id <id>`<br>
  Opens the current directory's existing session with the ID, or creates it otherwise. IDs accept letters, numbers, `.`, `_`, and `-`.
- `--fork <path|id>`<br>
  Forks a session, chosen by file path or full/partial ID, into a new session in the current directory.
- `--session-dir <dir>`<br>
  Overrides storage and lookup. It takes precedence over `FINGERS_CODING_AGENT_SESSION_DIR` and the `sessionDir` setting.
- `--no-session`<br>
  Uses an in-memory session that is not persisted.
- `-n`, `--name <name>`<br>
  Sets the session display name.

Constraints:

- Session IDs must start and end with a letter or number.
- `--fork` cannot be combined with `--session`, `--continue`, `--resume`, or `--no-session`.
- `--session-id` cannot be combined with `--session`, `--continue`, or `--resume`. Combine it with `--fork` to choose the new ID.

<a id="tool-options"></a>

## Tools

```sh
fingers --tools read,grep,find,ls --print "Review this project"
```

See [Settings](settings.md#tools) for configuring the default tool selection.

- `-t`, `--tools <list>`<br>
  Replaces the default selection with a comma-separated allowlist of built-in, extension, or custom tools. Entries are tool names or patterns where `*` matches any characters. MCP tools are kept unless an entry starts with `mcp__` (see [MCP tools](#mcp-tools)). A list of only `+name` and `-name` entries is not an allowlist; it changes the default selection instead.
- `-xt`, `--exclude-tools <list>`<br>
  Disables comma-separated tool names or patterns after all other selection options, MCP tools included.
- `-nbt`, `--no-builtin-tools`<br>
  Disables default built-in tools while retaining extension and custom tools.
- `-nt`, `--no-tools`<br>
  Starts with all built-in, extension, custom, and MCP tools disabled.

Default enabled tools are `read`, `bash`, `edit`, and `write`, unless `defaultTools` changes them. `--tools` with plain names replaces the whole selection, so name every tool you want. Like `defaultTools`, it also accepts a list of only `+name` and `-name` entries, which adds tools to or removes them from the default selection: `fingers --tools +codemode,-write` keeps the other default tools, enables `codemode`, and disables `write`. These entries take exact tool names, not `*` patterns; use `--exclude-tools` to disable tools by pattern. Plain names and `+name`/`-name` entries cannot be mixed. `/reload` enables tools newly added to `defaultTools`, but a tool removed with `-name` stays removed.

<a id="mcp-tools"></a>

`--tools` selects the tools declared to the model. It does not remove MCP tools, whose reach is set by their [exposure](mcp.md#control-tool-exposure): `fingers --tools read,codemode` keeps every MCP tool callable from codemode scripts. An MCP tool that no entry names or matches is never declared directly, whatever its exposure; only `tool_search`, if listed, can load it. Once an entry starts with `mcp__`, `--tools` filters MCP tools too, so this keeps only the tools of the `github` server:

```sh
fingers --tools read,bash,codemode,'mcp__github__*'
```

The MCP resource tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) count as MCP tools. To remove MCP tools, use `--exclude-tools 'mcp__*'` or [`--no-mcp`](#resource-options).

| Built-in | Purpose |
|---|---|
| `read` | Read text files and supported images |
| `bash` | Run shell commands |
| `powershell` | Run PowerShell commands on Windows |
| `edit` | Apply exact text replacements to an existing file |
| `write` | Create or overwrite a file |
| `grep` | Search file contents |
| `find` | Find paths using glob patterns |
| `ls` | List directory contents |

Built-in extensions add two more tools. They are off by default; the MCP extension turns them on when an MCP server needs them (see [MCP](mcp.md#control-tool-exposure)). To enable them yourself, name them in `--tools` or `defaultTools`.

| Built-in extension | Purpose |
|---|---|
| `codemode` | Run JavaScript that calls the other tools, for example in parallel with `Promise.allSettled`; only the script's output reaches the model |
| `tool_search` | Search tools that are not declared to the model (`codemode` and `deferred` exposure, such as MCP tools) and declare the matches for the next call |

### Enable codemode

To turn on `codemode` for every session, add it to the default tools in `~/.fingers/agent/settings.json` or a project's `.fingers/settings.json`:

```json
{
  "defaultTools": ["+codemode"]
}
```

This keeps `read`, `bash`, `edit`, and `write` and adds `codemode`. For one invocation, add it with `--tools`:

```sh
fingers --tools +codemode
```

Codemode is useful without MCP: scripts can run several tool calls in parallel, filter large output before it reaches the model, call classifier models such as TypeSafe's Jev through `models.classify()` (see [Classifier models](models.md#use-classifier-models)), and generate images through `models.generateImages()` (see [Image models](models.md#use-image-models)).

### How codemode works

Scripts run in a QuickJS sandbox and reach the other tools through `tools.<name>(args)`. [Codemode](codemode.md) describes the script API, how tools are listed and found, the `store()` and `models` globals, and the limits.

### Tool search

`tool_search` is off by default; enable it with `"defaultTools": ["+tool_search"]` or `--tools`. It uses the same ranking as `searchTools()` over tools that are not declared yet and declares the matches for the next model call. Loaded tools are recorded in the session like other tool changes, so they stay declared on that branch.

<a id="resource-options"></a>

## Resources

```sh
fingers --extension ./review.ts
```

See [Configuration](configuration.md) for conventional directories and project trust, [Settings](settings.md#resources) for configured paths, and [Fingers Packages](packages.md) for package sources.

- `-e`, `--extension <path>`<br>
  Loads an extension file or directory, or a built-in extension such as `builtin:mcp`, and is repeatable.
- `-ne`, `--no-extensions`<br>
  Disables discovered, configured, and built-in extensions. Explicit `-e` paths still load, so `fingers -ne -e builtin:mcp` keeps only the built-in MCP support.
- `--no-mcp`<br>
  Disables the built-in MCP support for this run: no servers connect, and there are no MCP tools or `/mcp`. It does not affect an extension that replaces the built-in MCP support.
- `--skill <path>`<br>
  Loads a skill file or directory and is repeatable.
- `-ns`, `--no-skills`<br>
  Disables discovered and configured skills. Explicit `--skill` paths still load.
- `--prompt-template <path>`<br>
  Loads a prompt-template file or directory and is repeatable.
- `-np`, `--no-prompt-templates`<br>
  Disables discovered and configured templates. Explicit `--prompt-template` paths still load.
- `--theme <path>`<br>
  Loads a theme file or directory and is repeatable.
- `--use-theme <name[/name]>`<br>
  Selects the initial interactive theme for this run.
- `--no-themes`<br>
  Disables discovered and configured themes. Explicit `--theme` paths still load.
- `-nc`, `--no-context-files`<br>
  Disables `AGENTS.md` and `CLAUDE.md` discovery.

Resource paths apply only to the current process. Relative paths resolve from the current working directory.

<a id="prompt-and-display-options"></a>

## Prompts and process

```sh
fingers --append-system-prompt ./instructions.md
```

See [Configuration](configuration.md) for saved configuration, [Security](security.md#understand-project-trust) for project trust, and [Environment Variables](environment-variables.md) for process controls.

- `--system-prompt <text|path>`<br>
  Replaces the default system prompt with text or the contents of an existing file.
- `--append-system-prompt <text|path>`<br>
  Appends text or an existing file to the system prompt and is repeatable.
- `--tui-mode <mode>`<br>
  Uses `fullscreen` (default) or `regular` terminal mode.
- `--verbose`<br>
  Shows verbose interactive startup information, overriding `quietStartup`.
- `-a`, `--approve`<br>
  Trusts project-local configuration and resources for this process.
- `-na`, `--no-approve`<br>
  Ignores trust-gated project-local configuration and resources for this process.
- `--offline`<br>
  Disables automatic network activity, including model catalog refreshes. Equivalent to `FINGERS_OFFLINE=1`.
- `-h`, `--help`<br>
  Shows help, including flags registered by loaded extensions, then exits.
- `-v`, `--version`<br>
  Shows the Fingers version, then exits.

Extensions may register additional long-form options. Unknown short options are rejected.

## Package commands

```sh
fingers install npm:@scope/package
```

See [Fingers Packages](packages.md) for source formats, filtering, installation, and project scope.

### Common tasks

| Task | Command |
|---|---|
| Install a package | `fingers install <source>` |
| List configured packages | `fingers list` |
| Remove a package and its settings entry | `fingers remove <source>` |
| Configure which package resources load | `fingers config` |

Add `--local` or `-l` to `install`, `remove`, `uninstall`, or `config` to use project settings instead of global settings.

### Update Fingers or packages

Running `fingers update` without a target updates Fingers itself.

| Task | Command |
|---|---|
| Update Fingers | `fingers update` |
| Update all installed packages | `fingers update --extensions` |
| Update one installed package | `fingers update <source>` |
| Refresh model catalogs | `fingers update --models` |
| Update Fingers and all installed packages | `fingers update --all` |

Add `--force` to reinstall Fingers when the selected update includes Fingers.

`fingers update` cannot update Fingers when another package manager provides it. Update Fingers with that package manager. Package and model catalog updates still work.

#### Custom update command

If a wrapper or another package manager provides Fingers, set `FINGERS_SELF_UPDATE_COMMAND` so `fingers update` runs its update command:

```sh
export FINGERS_SELF_UPDATE_COMMAND="mise use -g npm:{packageName}@{version}"
```

`fingers update` runs it only when the npm registry has a newer release, replacing `{packageName}`, `{version}`, and `{installSpec}` (`{packageName}@{version}`) with that release. The value is split on spaces. For arguments with spaces, use the `selfUpdateCommand` setting in `~/.fingers/agent/settings.json` instead, an argv array such as `["nix", "profile", "upgrade", "fingers"]`.

### Aliases and command options

- `fingers uninstall <source>` is an alias for `fingers remove <source>`.
- `fingers update --self`, `fingers update self`, and `fingers update fingers` are aliases for `fingers update`.
- `fingers update --extension <source>` is an alias for `fingers update <source>`.
- `-a`, `--approve` trusts project-local files for one command. `-na`, `--no-approve` ignores trust-gated project-local files.
- Append `-h` or `--help` to a command for its exact usage and option constraints.

## Veyra account commands

`fingers login` signs in to your Veyra account with a device code (RFC 8628), like `/login` in a session. Fingers asks Veyra Connect for a code, opens the browser at Connect's device page, and shows the code; you check that the page shows the same code, pick the organization, and allow the device. In a terminal, `c` copies the code, `o` opens the link again, and `Esc` or `Ctrl+C` cancels. Signing in again replaces the sign-in, which is also how you switch organizations. Fingers shows and opens only a device page on the address of the Connect you sign in to; an answer that points anywhere else ends the sign-in before any code is shown. Over SSH, or on Linux without a display, it prints the address to open instead of opening a browser.

The sign-in is kept only in the OS keychain (macOS Keychain, Secret Service on Linux, Windows Credential Manager): the refresh token and the short-lived access tokens never go to a file. Without a usable keychain, or with `FINGERS_CREDENTIAL_STORE=file`, `fingers login` refuses; `/login` in a session then keeps the sign-in in memory for that session only. Model provider credentials are separate and stay under `fingers auth`.

`fingers whoami` prints the account, the organization with its tier, your group, which ee features are on (or why Fingers is core only), the Connect address, and where the sign-in is stored. It exits with status `1` when you are not signed in. `--json` prints the same facts as JSON (`ee.on`, `ee.features`, `ee.reason`), never a token, with control and bidi characters escaped as `\uXXXX`. `fingers login` ends with the same ee line. See [Open core](slash-commands.md#open-core).

`fingers logout` revokes the device's refresh token at Connect (RFC 7009) and removes the sign-in from the keychain. When Connect can't be reached or can't revoke it, the sign-in is still removed here and the command names the Connected apps page where you remove the device; it exits with status `1` when the revocation failed. When another fingers process holds the sign-in's lock for more than 30 seconds, `fingers logout` says so and signs out without the lock, since signing out is safe to repeat; a refresh that process was running then cannot bring the sign-in back. The revocation request gets 15 seconds from when it is sent. A `fingers login` that finishes at the same moment as such a sign-out is not kept: Fingers revokes its new refresh token and asks you to run `fingers login` again.

| Option | Applies to | Description |
|---|---|---|
| `--no-browser` | `login` | Print the address to open instead of opening the browser (automatic over SSH or without a display) |
| `--connect <url>` | All | Use another Veyra Connect; the default is `https://connect.veyra.so` or `FINGERS_CONNECT_URL`. The local stack is `https://connect.veyra.localhost` |
| `--json` | `whoami` | Print JSON |

```sh
fingers login
fingers whoami
FINGERS_CONNECT_URL=https://connect.veyra.localhost fingers login
fingers logout
```

Each sign-in, token refresh and sign-out is logged to `veyra.log` in the agent directory, one JSON record per line in the Veyra platform log format with the request and trace ids sent to Connect. No token or code is ever logged.

## Credential commands

`fingers auth login <provider>` logs in to a provider in the terminal and exits, without starting a session. It signs in with an account and opens the browser, like `/login <provider>`. Providers without account sign-in ask for an API key. It requires an interactive terminal.

| Option | Description |
|---|---|
| `--api-key` | Save an API key instead of signing in with an account; the key is read without echoing it |
| `--no-browser` | Do not open a browser; use the provider's other sign-in method, such as a device code, for example over SSH. Asks when there are several. Not allowed with `--api-key` |

`fingers auth logout <provider>` removes the credentials that `fingers auth login` or `/login` stored, like `/logout`. Environment variables and `models.json` config are unchanged. It exits with status `0` when nothing is stored, so it is safe to repeat.

```sh
fingers auth login anthropic
fingers auth logout anthropic
fingers auth check --provider openai --json
```

The other authentication commands require `--provider <provider>` or `--model <model>`. See [Providers](providers.md) for supported methods.

| Command | Description |
|---|---|
| `fingers auth check` | Print `ready`, `not_ready`, or `invalid`; exit with status `0`, `1`, or `2`, respectively |
| `fingers auth print-api-key` | Print the resolved API key |
| `fingers auth print-bearer-token` | Print a resolved OAuth bearer token |

| Option | Applies to | Description |
|---|---|---|
| `--provider <provider>` | All | Resolve credentials for a provider |
| `--model <model>` | All | Resolve credentials from a model; may be combined with `--provider` |
| `--json` | `auth check` | Write the structured result as JSON |
| `--credentials` | `auth check` | Emit the resolved credential when ready |
| `--no-refresh` | `auth check` | Do not refresh expired OAuth credentials; refresh is the default |
| `--min-expiry <duration>` | `print-bearer-token` | Require remaining token lifetime using `ms`, `s`, `m`, or `h`, such as `30m` |

Credential-printing commands write secrets to stdout.

## MCP commands

These commands work outside a session, so agents can run them through `bash`. See [MCP Servers](mcp.md).

| Command | Description |
|---|---|
| `fingers mcp add <server> [options] -- <command> [args...]` | Add or replace a stdio server in `mcp.json`; `--env KEY=VALUE` (repeatable) and `--cwd <dir>` set its environment and working directory. Arguments after the command are passed to it |
| `fingers mcp add <server> [options] --url <url>` | Add or replace a streamable HTTP server; `--header KEY=VALUE` (repeatable), `--bearer-token-env-var <NAME>` (sends `Authorization: Bearer ${NAME}`), `--oauth-client-id`, `--oauth-client-secret`, `--oauth-callback-port`, `--oauth-client-name`, and `--oauth-client-registration` (`auto`, `cimd`, or `dcr`) configure authentication |
| `fingers mcp remove <server>` | Remove a server from `mcp.json`; stored OAuth credentials are kept |
| `fingers mcp list [--json]` | Connect to every enabled server and print its state, tools, and errors; exit with `1` when a config entry is invalid or an enabled server is not connected |
| `fingers mcp login <server> [-l] [--timeout <seconds>]` | Sign in to an OAuth server: open the authorization page and wait for the browser; a terminal also accepts the pasted redirect URL. `--timeout` limits the whole sign-in, including requests to the authorization server (default 300 seconds). `-l` requires the server to be defined in the project's `.fingers/mcp.json` |
| `fingers mcp logout <server> [-l]` | Delete the stored OAuth credentials of a server |

`add` and `remove` change `~/.fingers/agent/mcp.json`, or `.fingers/mcp.json` in the current directory with `--local` (`-l`). `add` also takes `--exposure <mode>` (see [Exposure](mcp.md#control-tool-exposure)) and `--description <text>` and does not connect; run `fingers mcp list` to check the server.

Project `.fingers/mcp.json` files are only read for projects that are already trusted.
