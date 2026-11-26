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
| `/budget [dollars \| off]` | Set, show or remove the task budget (see [Budget](#budget)) |

### Budget

`/budget 5` (or `/budget $2.50`) sets a cost cap for the task in this session; `/budget` shows what was spent and what is left, `/budget off` removes the cap. The spend is what the session's model calls cost at the models' list prices, the same number as the cost on the status line, so summaries count too. The status line shows `budget $4.94 left of $5.00`.

The cap is a hard stop: the model call that reaches it finishes, its tool calls finish, and Fingers makes no further model call. A new prompt is refused with `Budget reached: …` until you raise or remove the cap (extension commands still run). A new, resumed or forked session is a new task: its spend starts from what that session recorded, under the same cap. A model without a list price costs nothing as far as the budget can tell; Fingers says once that the budget cannot stop that task. Budgets are part of the MIT core and need no sign-in. In managed RPC mode, `limits.max_cost_usd` uses the same stop.

## ee features

Commands tagged `ee` in the command menu are part of Fingers ee, under the Veyra commercial license in `ee/LICENSE`. They switch on after `fingers login` when your organization has the Fingers app on in Veyra Connect and its tier includes the feature; until then they show why they are locked, and the MIT core keeps working. See [Open core](#open-core).

| Command | Description |
|---|---|
| `/agents` | Sub-agents: start, watch, steer and stop them (Medium tier or higher) |
| `/memory [recall <query> \| remember <text> \| off \| on]` | Brain memory for this repository: status, search, save, off and on for the session (Medium tier or higher; see [Brain memory](#brain-memory)) |

### Open core

Fingers checks your organization's tier and apps with Veyra Connect when it starts, after `/login` and `/org`, and every hour. The last answer is kept with the sign-in in your OS keychain and counts for 72 hours while Connect can't be reached; after that, ee features stay off until Connect answers again. When Connect refuses (for example, you were removed from the organization), the kept answer is dropped. The status line shows `ee on` or `core only`, `/org` and `fingers whoami` say which features are on or why none are.

| Tier | ee features |
|---|---|
| Free | none |
| Low | token saving |
| Medium | token saving, sub-agents, checkpoints, Brain memory, Eyes telemetry |
| High | all of the above and organization hooks |

The tiers are placeholders until launch. A build without the `ee/` folder runs as the MIT core only.

### Token saving

With token saving on (Low tier or higher), Fingers changes what the model is sent in the terminal app, never what your tools do:

- **No duplicate reads.** Reading a file again that has not changed since the last read in this conversation (same file, offset and limit; same mtime, size and text) sends the model a one-line `[from cache, read once]` note instead of the text, which is still in its earlier read result. Reading it once more sends the text, a changed file is always read fresh, and after compaction, a move in `/tree` or another session every file is read fresh again.
- **Trimmed tool output.** A bash or PowerShell output longer than 60 lines reaches the model as its error lines and its last 20 lines, under a `[output trimmed to N of M lines …]` summary that names the file with the full output (the core's own file when it already cut the output, otherwise a new file in the temporary directory that only you can read).
- **Diff edits.** The system prompt asks the model to change existing files with `edit` instead of rewriting them with `write`.
- **Staged pruning before compaction.** Compaction starts when the context passes the window minus `compaction.reserveTokens`. Before that, at the end of a turn, old tool results are replaced by a one-line `[pruned by token saving]` note (which tool, which file or command, how big it was; run the tool again to get it back): from half of that limit the results older than the most recent `compaction.keepRecentTokens` (at most 40% of the limit) tokens, from three quarters the results older than half of that. Results under 200 tokens and the last two tool results stay. A batch is pruned only when it frees at least 1,000 tokens (5% of the limit for large windows) and, below three quarters, at least twice what the provider has to cache again after it, so the prompt cache breaks rarely. Each pruned result is saved in the session as a context edit (the session file keeps the original), so later requests and compaction get the note, even after you sign out. A pruned file is read fresh, not from the read cache. Compaction then runs less often and summarises the smaller context.
- **Compaction estimate.** When a compaction starts (`/compact` or automatic), the terminal shows what it should save (`Token saving: this compaction should save about N tokens (before → about after).`), and under the new summary what it saved and the estimate.
- **Cheaper-model routing.** A compaction summary runs on a cheaper model of the same provider (the same key) when one has room for it: the cheapest model whose blended price (three parts input, one part output) is at most 80% of the selected model's, on providers that serve several vendors (such as OpenRouter) only the selected model's vendor. The conversation stays on the model you selected. The terminal shows `Token saving: the compaction summary ran on <model> instead of <model> ($a instead of $b).`; when the cheaper model fails, the summary runs on the selected model. Sub-agents use the same rule for search tasks (cheapest) and review tasks (the strongest model between a quarter and 80% of the price). A virtual model's own router is never overridden. `"modelRouting": false` in [settings](settings.md) turns routing off.

Each saving goes to the session's savings ledger (estimated tokens per technique: `read_cache`, `output_trim`, `diff_edit`, `context_prune`; dollars at list price for `model_routing`), which the end-of-task report adds up. Managed RPC, print and JSON modes keep token saving off.

### Brain memory

With Brain on (Medium tier or higher), Fingers keeps one memory per repository in Veyra Brain: the repository of the `origin` remote (`github.com/acme/web`, the same for every clone and every member of the organization; credentials in the remote URL are never sent). A directory without a git remote has no memory. In the terminal app:

- **At the start of a task** (the first prompt of a session), Fingers asks Brain what to know for it, within 2,000 tokens, and adds the answer to the system prompt as a `<memory>` section framed as notes, not instructions. The answer is kept in the session, so later prompts, a resume or a fork keep the same section (and the prompt cache stays warm).
- **The model** gets `memory_recall` (search) and `memory_remember` (save one lasting fact, preference, procedure or episode; never secrets or personal data).
- **When a run ends**, Fingers sends Brain how it went (an `outcome` learning event with the task and the final answer, idempotent by run), so Brain learns from it.
- **One organization's memory stays in it.** The memory is the signed-in organization's (`<org_id>:<repository>`). After `/org switch`, or when you resume a session made while signed in to another organization, the kept `<memory>` section is not used: Fingers asks the new organization's Brain for the next prompt, and the earlier organization's memory section and recall results are taken out of every request to the model. The conversation itself (your prompts and the model's answers) stays as it is, so start a new session (`/new`) when you change organizations. A run belongs to the organization it started in: `/login`, `/logout` (Veyra) and `/org switch` wait until the run is over (the command stays in the editor), and if the sign-in still changes during a run, memory is off for the rest of that run (no recall, no save, no learning event to either organization).

Memory is best effort: when Brain does not answer in time (3 seconds at task start) or refuses, the session goes on without it and says so once. The status line shows `memory: Brain “web”` while it is on. `/memory off` turns it off for the repository until `/memory on` or a restart. Managed RPC mode never calls Brain itself: with `memory.mode: relay` it asks the host (see [Managed RPC](rpc-managed.md)); print and JSON modes have no memory.

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
