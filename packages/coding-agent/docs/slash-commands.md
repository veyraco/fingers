# Slash commands

Type `/` in Fingers' terminal editor to search the commands available in the current session. This page lists the built-in commands in the current Fingers release.

Extensions, prompt templates, and skills can add commands. The command menu in Fingers is therefore the exact reference for the resources loaded in your session.

## Models and settings

| Command | Description |
|---|---|
| `/settings` | Open settings |
| `/model [provider/model]` | Select a model |
| `/thinking [level]` | Set the thinking level |
| `/scoped-models` | Configure the models used by interactive cycling |
| `/login [provider]` | Without a provider, sign in to your Veyra account with a device code; with one, add that provider's authentication |
| `/org [switch]` | Show the Veyra organization, tier and group; `switch` signs in again to pick another organization |
| `/logout [provider]` | Without a provider, sign out of Veyra (revokes the device at Connect, clears the keychain); with one, remove that provider's stored credentials |
| `/llama` | Manage models on the configured llama.cpp router |

## ee features

Commands tagged `ee` in the command menu are part of Fingers ee, under the Veyra commercial license in `ee/LICENSE`. They switch on after `fingers login` when your organization has the Fingers app on in Veyra Connect and its tier includes the feature; until then they show why they are locked, and the MIT core keeps working. See [Open core](#open-core).

| Command | Description |
|---|---|
| `/agents` | Sub-agents: start, watch, steer and stop them (Medium tier or higher) |

### Open core

Fingers checks your organization's tier and apps with Veyra Connect when it starts, after `/login` and `/org`, and every hour. The last answer is kept with the sign-in in your OS keychain and counts for 72 hours while Connect can't be reached; after that, ee features stay off until Connect answers again. When Connect refuses (for example, you were removed from the organization), the kept answer is dropped. The status line shows `ee on` or `core only`, `/org` and `fingers whoami` say which features are on or why none are.

| Tier | ee features |
|---|---|
| Free | none |
| Low | token saving |
| Medium | token saving, sub-agents, checkpoints, Brain memory, Eyes telemetry |
| High | all of the above and organization hooks |

The tiers are placeholders until launch. A build without the `ee/` folder runs as the MIT core only.

## Sessions and context

| Command | Description |
|---|---|
| `/new` | Start a new session |
| `/resume` | Resume another session |
| `/name [name]` | Set the session display name, or show the current name when omitted |
| `/session` | Show current session information and statistics |
| `/tree` | Navigate the session tree |
| `/fork` | Create a new session from an earlier user message |
| `/clone` | Duplicate the current session at its current position |
| `/compact [instructions]` | Compact the current context, optionally with custom instructions |
| `/import <path>` | Import a JSONL session, preserving its ID and working directory |

## Export and share

| Command | Description |
|---|---|
| `/copy` | Copy the last assistant message |
| `/export [path]` | Export the session as HTML or JSONL |
| `/share` | Upload the session and return a viewer link |
| `/bug [description]` | Prepare a private bug report for the Fingers developers |

Review a session before exporting or sharing it. Sessions can contain prompts, tool arguments, command output, file contents, and credentials exposed during the conversation.

## Runtime and project

| Command | Description |
|---|---|
| `/trust` | Save a project trust decision for future Fingers processes |
| `/mcp` | Manage MCP servers: sign in, reconnect, enable or disable, and change exposure |
| `/reload` | Reload keybindings, extensions, skills, templates, themes, and context files |
| `/hotkeys` | Show active keyboard shortcuts |
| `/changelog` | Show changelog entries |
| `/quit` | Quit Fingers |

## Commands added by resources

- Extensions can register commands with their own arguments and completion behavior.
- Each prompt template is available under its template name.
- Skills are available as `/skill:name` when skill commands are enabled.

Use `/reload` after adding or changing a discovered command resource. See [Extensions](extensions.md), [Prompt Templates](prompt-templates.md), and [Skills](skills.md) for their loading and naming rules.
