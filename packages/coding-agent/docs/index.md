# Fingers

Fingers is an extensible AI agent that works from your terminal. Give it a goal and a working folder, and it can inspect files, run commands, edit content, and work through multi-step tasks.

Use Fingers for software development, research notes, writing projects, data files, or hobby work. You can use Fingers as is, prompt it to adapt itself to your workflow, or build other applications powered by Fingers using the SDK.

## Start using Fingers

New to Fingers? Follow the [Quickstart](quickstart.md) to install Fingers, connect a model, and complete your first task.

If Fingers is already installed, choose what you want to do:

- [Use Fingers interactively](usage.md) to add files, run commands, direct ongoing work, and export results.
- [Choose a model](models.md) or connect a subscription, API key, local model, or compatible endpoint.
- [Continue or branch a session](sessions.md) to resume work or explore another approach without losing history.
- [Configure Fingers](configuration.md) for your preferences, working folders, instructions, and reusable resources.
- [Understand how Fingers works](how-fingers-works.md), including tools, context, sessions, and the agent loop.

## Customize Fingers

Fingers can reuse prompts, load specialized instructions, add executable integrations, change its terminal interface, connect model services, and distribute these resources as packages.
Use the [Quickstart customization chooser](quickstart.md#choose-how-to-customize-fingers) to select the smallest mechanism that meets your need.

## Automate or embed Fingers

- Use [print mode](cli.md#invocation-and-output) for one-off and scripted tasks.
- Use [JSON event stream mode](json.md) to consume structured events from one run.
- Use [RPC mode](rpc.md) to control a separate Fingers process.
- Use the [TypeScript SDK](sdk.md) to run Fingers inside an application.

## Find reference and setup information

Use the reference pages to look up [CLI options](cli.md), [settings](settings.md), [providers](providers.md), [keybindings](keybindings.md), and [environment variables](environment-variables.md). [Open Core](open-core.md) says what is MIT and what is part of Fingers ee.

For platform-specific help, see [Terminal Setup](terminal-setup.md), [Windows](windows.md), [tmux](tmux.md), [Termux on Android](termux.md), or [Containerization](containerization.md).

## Work safely

Fingers' tools and extensions run with the permissions of the Fingers process. Project trust controls which project resources Fingers loads, but it does not sandbox tool calls. Review [Security](security.md) before using untrusted files, repositories, extensions, or unattended automation.
