# Run a session in Hands

`fingers --hands "<task>"` runs the session in a fresh Veyra Hands Sandbox instead of on this computer. Hands starts its runner and Fingers inside the sandbox, the agent works there, and the files it changed come back into your working tree when the run ends. The sandbox is one-shot: Hands destroys it at the end of every run, and `Ctrl+C` cancels the run.

It needs a Veyra sign-in (`fingers login`) to an organization that has Hands on, and a model connection in Connect that lists both `fingers` and `hands` among its apps; see [Model connections from Veyra](providers.md#model-connections-from-veyra). The model calls go through Hands' model proxy with that connection, so the provider key never reaches the sandbox or this computer.

```sh
fingers --hands "Fix the failing invoice export test"
fingers --hands --model veyra-mc_anthropic/claude-sonnet-4-5 "Add a changelog entry"
fingers --hands -p "Run the tests and report" > report.txt
```

## What goes into the sandbox

- **A pushed git repository.** When the `origin` remote is a GitHub repository (or another `https` remote) and `HEAD` is on one of its branches, Hands clones it at `HEAD`. Your uncommitted changes (modified and untracked files that `.gitignore` does not ignore) go along on top. A deleted file can't go along: commit or stash the deletion first.
- **Anything else.** Without a remote Hands can clone, with `HEAD` not pushed, or outside git, Fingers uploads the files themselves (`.gitignore` applies inside git; `.git`, `node_modules` and `.fingers` are left out).
- Hands takes at most 100 files without a pushed commit, and 500 MiB per file. Symbolic links are left out.

## While the run works

The session prints what the agent says, the tools it runs, the files it changes and its checkpoints. In a terminal:

- a line you type is sent to the agent, which reads it at its next step;
- when a tool call waits for approval, `y` approves it and anything else denies it, with your text as the reason;
- `/stop` or `Ctrl+C` cancels the run; its changes up to then still come back. `Ctrl+C` again leaves at once.

With `-p`, or without a terminal, approvals wait in the Hands console, where you decide them. `--mode json` prints each Hands run event as one JSON line, then a `fingers.hands.summary` line.

## When the run ends

Each changed file is written into the working tree and each deleted one removed. A file you changed yourself while the run worked is kept as you left it; the run's version is saved under `.fingers/hands/<run id>/` instead, and the session names it. Then the session shows the run's status, time, tokens, cost and its Eyes link.

In a terminal you can then type the next message for the same session. When your files are still what came back, the next run continues the conversation from the last run's checkpoint; when you changed them, it starts a fresh run with your files. An empty line, `/exit` or `Ctrl+D` ends the session.

The exit status is `0` when the run succeeded, `1` when it failed or could not start, and `130` when you stopped it.

## Memory and telemetry

- **Brain.** When the organization has Brain on and Brain already keeps a memory for the repository (named by the `origin` remote, see [Brain memory](slash-commands.md#brain-memory)), the run gets that memory. The session's header says `memory: Brain <repo>`, or why memory is off. Until Hands gives runs Brain memory, it refuses it, and the run goes ahead without memory (`memory: off (Hands: …)`).
- **Eyes.** The run's events and Fingers' telemetry go to Eyes when the organization has Eyes on and the Hands feed is turned on there.

## Options

| Option | Description |
|---|---|
| `--hands` | Run the session in a Hands Sandbox |
| `--hands-size <size>` | The sandbox size, such as `standard-4`; the default is the organization's |
| `--local` | Run here even when the `hands.default` setting is on |
| `--model veyra-<connection>/<model>`, `--provider veyra-<connection>` | The model connection and model; the default is your default model when it is a Veyra connection, else the first connection with its first tested model |

`--hands` can't be combined with `--mode rpc`, `--managed`, `--continue`, `--resume`, `--session`, `--session-id`, `--fork` or `@file` arguments, and it does not work offline. The setting `hands.default: true` starts sessions in Hands as if `--hands` were given, except for invocations with those flags; see [Settings](settings.md#veyra-hands).
