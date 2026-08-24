import {
  createCloudProvider,
  renderInnerCommand,
  type AttachKind,
  type AttachSpec,
  type BoxRecord,
  type BuildAttachOptions,
  type CloudBackend,
  type CreateBoxRequest,
  type Provider,
} from '@madarco/agentbox-provider-sdk';
import {
  SPRITES_RESOURCES,
  type SpritesBackendDependencies,
} from './backend.js';
import type { SpritesTransport } from './cli.js';

function spriteNameFor(box: BoxRecord): string {
  const spriteName = box.cloud?.sandboxId;
  if (!spriteName) throw new Error(`Sprites box ${box.name} has no sandbox id`);
  return spriteName;
}

export function buildSpritesAttach(
  binary: string,
  spriteName: string,
  kind: AttachKind,
  options?: BuildAttachOptions,
): AttachSpec {
  const inner = renderInnerCommand(kind, options);
  const interactive = options?.detached !== true && kind !== 'logs';
  return {
    argv: [
      binary,
      'exec',
      '--sprite',
      spriteName,
      '--no-port-forward',
      ...(interactive ? ['--tty'] : []),
      '--',
      'bash',
      '-lc',
      inner,
    ],
  };
}

export function createSpritesProvider(
  backend: CloudBackend,
  cli: Pick<SpritesTransport, 'binary' | 'ensureAgentboxService'>,
): Provider {
  const cloudProvider = createCloudProvider(backend, {
    defaultResources: { ...SPRITES_RESOURCES },
    launchDockerd: false,
  });

  const ensureService = async (box: BoxRecord): Promise<void> => {
    await cli.ensureAgentboxService(spriteNameFor(box));
  };

  return {
    ...cloudProvider,

    async create(request: CreateBoxRequest) {
      // The current Sprites base does not ship a browser/VNC stack. Disable the
      // scaffold's default VNC launch rather than advertising a dead endpoint.
      const created = await cloudProvider.create({
        ...request,
        vnc: { enabled: false },
      });
      try {
        await ensureService(created.record);
      } catch (error) {
        try {
          await cloudProvider.destroy(created.record);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `AgentBox record ${created.record.name} may remain after Sprite service setup failed`,
          );
        }
        throw error;
      }
      return created;
    },

    async start(box: BoxRecord) {
      const next = await cloudProvider.start(box);
      await ensureService(next);
      return next;
    },

    async reconnect(box: BoxRecord) {
      const next = await cloudProvider.reconnect(box);
      await ensureService(next);
      return next;
    },

    async buildAttach(
      box: BoxRecord,
      kind: AttachKind,
      options?: BuildAttachOptions,
    ): Promise<AttachSpec> {
      return buildSpritesAttach(cli.binary, spriteNameFor(box), kind, options);
    },
  };
}

export type { SpritesBackendDependencies };
