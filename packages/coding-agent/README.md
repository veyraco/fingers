<p align="center">
  <a href="https://fingers.veyra.so">
    <img alt="Fingers logo" src="https://fingers.veyra.so/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@veyraco/fingers"><img alt="npm" src="https://img.shields.io/npm/v/@veyraco/fingers?style=flat-square&logo=npm&logoColor=white" /></a>
</p>

> New issues and PRs from new contributors are closed automatically. Maintainers review closed submissions daily. See [CONTRIBUTING.md](https://github.com/veyraco/fingers/blob/main/CONTRIBUTING.md).

# Fingers

Fingers is a minimal, extensible agent harness that you can make your own.

Adapt Fingers to your workflows, not the other way around. Customize Fingers with [extensions](docs/extensions.md), [skills](docs/skills.md), [prompt templates](docs/prompt-templates.md), and [themes](docs/themes.md). Bundle them as [Fingers packages](docs/packages.md) and share via npm or git.

Fingers ships with powerful defaults but skips features like sub-agents and plan mode. Ask Fingers to build what you want, or install a package that does it your way.

Use Fingers [interactively](docs/usage.md), automate it in [print or JSON mode](docs/cli.md), control it over [RPC](docs/rpc.md), or build apps with the [Fingers TypeScript SDK](docs/sdk.md). See [OpenClaw](https://github.com/OpenClaw/OpenClaw) for a real-world integration.

## Getting started

Install the command-line interface:

```bash
curl -fsSL https://fingers.veyra.so/install.sh | sh
```

On Windows:

```shell
powershell -c "irm https://fingers.veyra.so/install.ps1 | iex"
```

The installer pins all dependencies and updates Fingers with `fingers update`. Alternatively, install directly with npm, which does not pin transitive dependencies:

```bash
npm install -g --ignore-scripts @veyraco/fingers
```

Fingers requires Node.js 22.19 or newer. The macOS, Linux, and Windows installers can install it if needed. Fingers does not require dependency lifecycle scripts for a normal npm installation.

On macOS and Linux, Nix users can install the latest release with `nix profile add github:veyraco/fingers/stable`. See the [quickstart](docs/quickstart.md#1-install-fingers) for updating and pinning releases.

Start Fingers in the directory where you want it to work:

```bash
cd /path/to/project
fingers
```

For a built-in AI provider, run `/login` inside Fingers to connect a subscription or API key. Then give Fingers a task.

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
