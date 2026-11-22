<p align="center">
  <a href="https://www.npmjs.com/package/@veyraco/fingers"><img alt="npm" src="https://img.shields.io/npm/v/@veyraco/fingers?style=flat-square&logo=npm&logoColor=white" /></a>
</p>

# Fingers

Fingers is a minimal, extensible agent harness that you can make your own.

Adapt Fingers to your workflows, not the other way around. Customize Fingers with [extensions](docs/extensions.md), [skills](docs/skills.md), [prompt templates](docs/prompt-templates.md), and [themes](docs/themes.md). Bundle them as [Fingers packages](docs/packages.md) and share via npm or git.

Fingers ships with powerful defaults but skips features like sub-agents and plan mode. Ask Fingers to build what you want, or install a package that does it your way.

Use Fingers [interactively](docs/usage.md), automate it in [print or JSON mode](docs/cli.md), control it over [RPC](docs/rpc.md), or build apps with the [Fingers TypeScript SDK](docs/sdk.md). See [OpenClaw](https://github.com/OpenClaw/OpenClaw) for a real-world integration.

## Getting started

Install the command-line interface from npm:

```bash
npm install -g --ignore-scripts @veyraco/fingers
```

Fingers requires Node.js 22.19 or newer and does not require dependency lifecycle scripts. Update it with `fingers update`, which installs the npm registry's latest release.

Start Fingers in the directory where you want it to work:

```bash
cd /path/to/project
fingers
```

For a built-in AI provider, run `/login <provider>` inside Fingers (for example `/login anthropic`) to connect a subscription or API key; `/login` alone signs in to your Veyra account. Then give Fingers a task.

See the [documentation](docs/index.md) for full setup and usage instructions.

## Development

Clone the repository, install its dependencies, and run Fingers from source:

```bash
git clone https://github.com/veyraco/fingers
cd fingers
npm install --ignore-scripts
./fingers-test.sh
```

`fingers-test.sh` can be called from any directory and preserves the caller's working directory.

Before submitting changes, run:

```bash
npm run check
./test.sh
```

Read [CONTRIBUTING.md](https://github.com/veyraco/fingers/blob/main/CONTRIBUTING.md) before opening an issue or pull request. It defines the contribution gate, issue quality bar, and required checks. Read [AGENTS.md](https://github.com/veyraco/fingers/blob/main/AGENTS.md) for repository-specific implementation, testing, dependency, and release rules.

## License

MIT
