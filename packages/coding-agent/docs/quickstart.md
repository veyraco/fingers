# Quickstart

Fingers runs in your terminal and works with files on your machine. To use it, you need access to a model through a supported provider. This can be a subscription, an API key, or a local model.

For native Windows setup, read [Windows Setup](windows.md). For Android, read [Termux Setup](termux.md).

## 1. Install Fingers

Install Fingers from npm on macOS, Linux, or Windows. This requires Node.js 22.19 or newer:

```bash
npm install -g --ignore-scripts @veyraco/fingers
```

Fingers does not require dependency lifecycle scripts for a normal npm installation. `fingers update` updates it to the npm registry's latest release.

Verify the installation:

```bash
fingers --version
```

## 2. Start Fingers

Change to the folder you want Fingers to work with, then start it:

```bash
cd /path/to/folder
fingers
```

The working folder helps Fingers discover relevant files, instructions, and configuration. Fingers also uses it to group saved sessions.


The interface shows your conversation, an editor for prompts and commands, and a footer with the current folder, model, and session status. See [Use Fingers in the terminal](usage.md) to learn how to add files, run commands, direct ongoing work, and manage results.

## 3. Choose a model

A **model** generates Fingers' responses. A **provider** is the service or account Fingers uses to access that model.

In Fingers, run:

```text
/login
```

Choose a provider, then follow the prompts to use a subscription or store an API key. Run `/model` afterward if you want to select a different available model.

See [Choose a model and provider](models.md) for supported providers, environment-variable authentication, local models, and custom endpoints.

## 4. Give Fingers a task

Fingers shows each file read, search, command, and edit it performs. It does not ask before every tool call.

Enter a task that matches your work, for example:

```text
Summarize @meeting-notes.md and save the action items to action-items.md.
```

```text
Explain how this repository is structured and how to run its checks.
```

```text
Compare @previous.csv with @current.csv and summarize the important changes.
```

Type `@` in the editor to search for a file instead of entering its full path. When Fingers finishes, review its response and any changed files. Use version control or backups for important work. For untrusted or unattended work, use a container or another sandbox. See [Security](security.md).

## Continue later

Fingers saves sessions automatically. Exit Fingers, then resume the most recent session for the same working folder with:

```bash
fingers --continue
```

Use `/resume` to choose another saved session. See [Continue or branch a session](sessions.md) for session naming, branching, compaction, export, and sharing.

## Next steps

- [Use Fingers interactively](usage.md) to learn input, commands, shortcuts, and queued messages.
- [Add instructions](configuration.md#context-files) that Fingers should follow whenever it works in a folder.
- [Choose a model and provider](models.md).

### Choose how to customize Fingers

Start with the least powerful mechanism that meets your need:

| Need | Start with |
|---|---|
| Give Fingers persistent instructions for a folder | [`AGENTS.md`](configuration.md#context-files) |
| Reuse a prompt from the `/` menu | [Prompt template](prompt-templates.md) |
| Add task-specific instructions and supporting files | [Skill](skills.md) |
| Add executable tools, commands, or event handlers | [Extension](extensions.md) |
| Build a custom terminal component | [Terminal UI](tui.md) |
| Connect an unsupported model service | [Custom provider](custom-provider.md) |
| Install or distribute several resources | [Fingers package](packages.md) |

## Uninstall Fingers

If you installed Fingers with npm, run:

```bash
npm uninstall -g @veyraco/fingers
```

This does not remove configuration, credentials, sessions, or installed Fingers packages from `~/.fingers/agent/`.
