# agentbox-provider-sprites

Run [AgentBox](https://agent-box.sh) agents in persistent, hardware-isolated [Sprites](https://sprites.dev) environments.

This is a community provider plugin. It is maintained outside AgentBox core and loaded through `@madarco/agentbox-provider-sdk`.

## Requirements

- Node.js 20.10 or newer
- AgentBox with provider SDK API v2 support
- The [`sprite` CLI](https://docs.sprites.dev/cli/installation)
- An authenticated Sprites organization

Install and authenticate the Sprite CLI if needed:

```bash
curl -fsSL https://sprites.dev/install.sh | sh
sprite login
```

## Install

```bash
npm i -g agentbox-provider-sprites
agentbox plugin add agentbox-provider-sprites
agentbox plugin list
agentbox doctor
```

`agentbox plugin add` is the trust boundary. Provider plugins run in-process with the same host and credential access as AgentBox itself.

## Use

From a Git repository:

```bash
agentbox create --provider sprites --no-vnc
agentbox claude --provider sprites --no-vnc
agentbox codex --provider sprites --no-vnc
agentbox opencode --provider sprites --no-vnc
```

The provider disables VNC even when `--no-vnc` is omitted because the current Sprite base image does not include the AgentBox browser/VNC stack.

Lifecycle commands work normally:

```bash
agentbox pause <box>
agentbox unpause <box>
agentbox shell <box>
agentbox url <box>
agentbox destroy <box>
```

No `agentbox prepare` step is required. The provider installs the AgentBox runtime into each new Sprite using version-matched assets from the running AgentBox CLI.

## Credentials

The provider uses the official Sprite CLI transport, including its configured organization and keychain credentials. `sprite login` is the recommended setup.

For headless environments, set `SPRITE_TOKEN` in the process environment or in AgentBox's mode-0600 secret store:

```dotenv
# ~/.agentbox/secrets.env
SPRITE_TOKEN='your-token'
```

Keep that file mode `0600`.

API request bodies, AgentBox relay tokens, and remote execution environments are streamed over stdin rather than placed in host-visible process arguments.

## How it maps to Sprites

| AgentBox operation | Sprites implementation |
| --- | --- |
| Create | Create a labeled Sprite and install the AgentBox runtime |
| Exec | Official `sprite exec` WebSocket transport |
| Upload/download | `sprite file push` / `sprite file pull` |
| Interactive attach | `sprite exec --tty` with AgentBox's tmux command |
| Browser URL | Stable, organization-authenticated `sprites.app` URL |
| Relay preview | Private localhost proxy backed by `sprite proxy --stdio` |
| Pause/stop | Stop the AgentBox service and daemon, then allow automatic Sprite hibernation |
| Resume/start | Wake the Sprite, bootstrap AgentBox, and restore its Sprite service |
| Destroy | Delete the Sprite and local provider state |
| Prune inventory | List only Sprites labeled as AgentBox-managed |

Lifecycle transitions use a cross-process filesystem fence so a tray, CLI, and host relay cannot race pause against service restoration. A paused Sprite becomes `warm` after Sprites' idle window and may later become `cold`; its filesystem persists in both states.

## Platform resources

Sprites currently provide platform-managed resources:

- 8 vCPUs
- Memory managed and scaled by the platform
- 100 GB persistent storage

AgentBox `--cpus`, `--memory`, `--disk`, `--size`, and `--location` settings do not resize a Sprite.

## Limitations

- No AgentBox VNC/browser stack
- No nested Docker support through this provider
- No AgentBox cross-Sprite checkpoints: Sprites checkpoints restore the same Sprite and cannot seed a different Sprite
- The macOS tray/hub does not yet discover external provider plugins; use the CLI until [madarco/agentbox#306](https://github.com/madarco/agentbox/issues/306) is resolved
- The provider depends on the `sprite` CLI being available on the host `PATH`

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
agentbox plugin add .
```

The test suite covers the backend contract, process-boundary secret handling, lifecycle fencing, cleanup failures, credential hooks, attach arguments, and package exports. A release is not ready unless all four verification commands pass.

## Support

- Provider bugs: [github.com/philippgerard/agentbox-provider-sprites/issues](https://github.com/philippgerard/agentbox-provider-sprites/issues)
- AgentBox provider API: [Build a provider](https://agent-box.sh/docs/build-a-provider)
- Sprites documentation: [docs.sprites.dev](https://docs.sprites.dev)

## License

MIT
