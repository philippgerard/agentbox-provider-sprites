import {
  type CloudBackend,
  type CloudHandle,
  type CloudState,
} from '@madarco/agentbox-provider-sdk';
import {
  SpritesCli,
  type SpriteDetails,
  type SpritesTransport,
} from './cli.js';
import {
  installSpritesRuntime,
  resolveSpritesRuntime,
  type ResolvedRuntime,
} from './runtime.js';

export const SPRITES_PROVIDER_NAME = 'sprites';
export const SPRITES_WEB_PROXY_PORT = 8080;
export const SPRITES_RESOURCES = { cpu: 8, disk: 100 } as const;
const AGENTBOX_LABEL = 'agentbox';

export interface SpritesBackendDependencies {
  cli: SpritesTransport;
  resolveRuntime: () => ResolvedRuntime;
  installRuntime: (
    cli: Pick<SpritesTransport, 'uploadFiles' | 'execArgv'>,
    spriteName: string,
    runtime: ResolvedRuntime,
    onLog?: (line: string) => void,
  ) => Promise<void>;
}

export function cloudStateFromSpriteStatus(status: string | undefined): CloudState {
  switch (status?.toLowerCase()) {
    case 'warm':
    case 'paused':
    case 'suspended':
      return 'paused';
    case 'cold':
    case 'stopped':
    case 'failed':
      return 'stopped';
    case 'deleted':
    case 'deleting':
      return 'missing';
    default:
      return 'running';
  }
}

function handleFor(sprite: SpriteDetails): CloudHandle {
  return {
    sandboxId: sprite.name,
    resources: { ...SPRITES_RESOURCES },
  };
}

export function createSpritesBackend(
  dependencies: Partial<SpritesBackendDependencies> = {},
): { backend: CloudBackend; cli: SpritesTransport } {
  const cli = dependencies.cli ?? new SpritesCli();
  const resolveRuntime = dependencies.resolveRuntime ?? resolveSpritesRuntime;
  const installRuntime = dependencies.installRuntime ?? installSpritesRuntime;

  const backend: CloudBackend = {
    name: SPRITES_PROVIDER_NAME,
    webProxyPort: SPRITES_WEB_PROXY_PORT,
    timeoutModel: 'inactivity',

    async provision(request) {
      if (request.snapshot) {
        throw new Error('Sprites checkpoints cannot seed a different Sprite');
      }

      // Resolve host runtime files before creating billable infrastructure. A
      // direct backend call outside AgentBox fails here without leaking a Sprite.
      const runtime = resolveRuntime();
      request.onLog?.(
        'Sprites use fixed platform resources (8 vCPU, managed memory, 100 GB storage)',
      );
      const sprite = await cli.createSprite(request.name, {
        labels: [AGENTBOX_LABEL, `agentbox-provider:${SPRITES_PROVIDER_NAME}`],
        ...(request.env ? { environment: request.env } : {}),
      });

      try {
        await installRuntime(cli, sprite.name, runtime, request.onLog);
      } catch (error) {
        try {
          await cli.deleteSprite(sprite.name);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `Sprite ${sprite.name} may remain after runtime installation failed`,
          );
        }
        throw error;
      }
      return handleFor(sprite);
    },

    async get(sandboxId) {
      const sprite = await cli.getSprite(sandboxId);
      return sprite ? handleFor(sprite) : null;
    },

    async list() {
      const sprites = await cli.listSprites();
      return sprites
        .filter((sprite) => sprite.labels?.includes(AGENTBOX_LABEL) === true)
        .map((sprite) => ({
          sandboxId: sprite.name,
          name: sprite.name,
          state: cloudStateFromSpriteStatus(sprite.status),
          ...(sprite.created_at ? { createdAt: sprite.created_at } : {}),
        }));
    },

    async start(handle) {
      await cli.wakeSprite(handle.sandboxId);
    },

    async stop(handle) {
      await cli.pauseSprite(handle.sandboxId);
    },

    async pause(handle) {
      await cli.pauseSprite(handle.sandboxId);
    },

    async resume(handle) {
      await cli.wakeSprite(handle.sandboxId);
    },

    async destroy(handle) {
      cli.closePreviewUrls(handle.sandboxId);
      await cli.deleteSprite(handle.sandboxId);
    },

    async state(handle) {
      const sprite = await cli.getSprite(handle.sandboxId);
      return sprite ? cloudStateFromSpriteStatus(sprite.status) : 'missing';
    },

    async exec(handle, command, options) {
      return cli.execShell(handle.sandboxId, command, {
        user: options?.user ?? 'vscode',
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.env ? { env: options.env } : {}),
        ...(options?.attemptTimeoutMs !== undefined
          ? { timeoutMs: options.attemptTimeoutMs }
          : {}),
      });
    },

    async uploadFile(handle, localPath, remotePath) {
      await cli.uploadFile(handle.sandboxId, localPath, remotePath);
      const ownership = await cli.execArgv(
        handle.sandboxId,
        ['sudo', '-n', 'chown', 'vscode:vscode', '--', remotePath],
        30_000,
      );
      if (ownership.exitCode !== 0) {
        throw new Error(
          `failed to assign uploaded file to vscode: ${ownership.stderr || ownership.stdout}`,
        );
      }
    },

    async downloadFile(handle, remotePath, localPath) {
      await cli.downloadFile(handle.sandboxId, remotePath, localPath);
    },

    async listFiles(handle, remoteDir) {
      return cli.listFiles(handle.sandboxId, remoteDir);
    },

    async previewUrl(handle, port) {
      return { url: await cli.previewUrl(handle.sandboxId, port) };
    },

    async signedPreviewUrl(handle) {
      // Browsers can use the Sprite's stable, org-authenticated HTTP URL. The
      // relay uses previewUrl() instead because its bridge bearer occupies the
      // Authorization header and therefore cannot also carry a Sprite token.
      const sprite = await cli.getSprite(handle.sandboxId);
      if (!sprite?.url) throw new Error(`Sprite ${handle.sandboxId} has no HTTP URL`);
      return { url: sprite.url };
    },

    async refreshPreviewUrl(handle, port) {
      return { url: await cli.refreshPreviewUrl(handle.sandboxId, port) };
    },
  };

  return { backend, cli };
}
