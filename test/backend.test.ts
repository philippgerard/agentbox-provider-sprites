import type { CloudHandle } from '@madarco/agentbox-provider-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  SPRITES_RESOURCES,
  cloudStateFromSpriteStatus,
  createSpritesBackend,
} from '../src/backend.js';
import {
  buildRemoteExecInvocation,
  type SpriteCreateOptions,
  type SpriteDetails,
  type SpriteExecOptions,
  type SpriteExecResult,
  type SpritesTransport,
} from '../src/cli.js';
import { buildSpritesAttach } from '../src/provider.js';
import type { ResolvedRuntime } from '../src/runtime.js';

function makeTransport(overrides: Partial<SpritesTransport> = {}): SpritesTransport {
  const transport: SpritesTransport = {
    binary: 'sprite',
    version: async () => 'sprite version test',
    login: async () => undefined,
    hasLocalCredentials: async () => true,
    probeCredentials: async () => true,
    createSprite: async (name) => ({ name, status: 'cold' }),
    getSprite: async (name) => ({ name, status: 'running' }),
    listSprites: async () => [],
    deleteSprite: async () => undefined,
    wakeSprite: async () => undefined,
    pauseSprite: async () => undefined,
    execShell: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    execArgv: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    uploadFile: async () => undefined,
    uploadFiles: async () => undefined,
    downloadFile: async () => undefined,
    listFiles: async () => [],
    previewUrl: async (_name, port) => `http://127.0.0.1:${String(port)}`,
    refreshPreviewUrl: async (_name, port) => `http://127.0.0.1:${String(port + 1)}`,
    closePreviewUrls: () => undefined,
    ensureAgentboxService: async () => undefined,
  };
  return Object.assign(transport, overrides);
}

const runtime: ResolvedRuntime = {
  localFiles: ['/runtime/ctl.cjs'],
  remoteInstaller: '/tmp/agentbox-runtime/install-box.sh',
};

function backendWith(
  cli: SpritesTransport,
  installRuntime: (
    transport: Pick<SpritesTransport, 'uploadFiles' | 'execArgv'>,
    spriteName: string,
    resolved: ResolvedRuntime,
    onLog?: (line: string) => void,
  ) => Promise<void> = async () => undefined,
) {
  return createSpritesBackend({
    cli,
    resolveRuntime: () => runtime,
    installRuntime,
  }).backend;
}

describe('Sprites CloudBackend', () => {
  it('creates, labels, installs, and reports fixed Sprite resources', async () => {
    const order: string[] = [];
    let createOptions: SpriteCreateOptions | undefined;
    const cli = makeTransport({
      createSprite: async (name, options) => {
        order.push('create');
        createOptions = options;
        return { name, status: 'cold' };
      },
    });
    const installRuntime = vi.fn(async () => {
      order.push('install');
    });
    const { backend } = createSpritesBackend({
      cli,
      resolveRuntime: () => {
        order.push('resolve');
        return runtime;
      },
      installRuntime,
    });

    const handle = await backend.provision({
      name: 'agentbox-demo-1',
      image: 'agentbox/box:dev',
      env: { AGENTBOX_BOX_ID: 'box-id' },
    });

    expect(order).toEqual(['resolve', 'create', 'install']);
    expect(createOptions).toEqual({
      environment: { AGENTBOX_BOX_ID: 'box-id' },
      labels: ['agentbox', 'agentbox-provider:sprites'],
    });
    expect(installRuntime).toHaveBeenCalledWith(cli, 'agentbox-demo-1', runtime, undefined);
    expect(handle).toEqual({
      sandboxId: 'agentbox-demo-1',
      resources: SPRITES_RESOURCES,
    });
  });

  it('deletes a partially provisioned Sprite when runtime installation fails', async () => {
    const deleteSprite = vi.fn(async () => undefined);
    const cli = makeTransport({ deleteSprite });
    const backend = backendWith(cli, async () => {
      throw new Error('install failed');
    });

    await expect(backend.provision({ name: 'broken', image: 'agentbox/box:dev' }))
      .rejects.toThrow('install failed');
    expect(deleteSprite).toHaveBeenCalledWith('broken');
  });

  it('reports both provisioning and orphan-cleanup failures', async () => {
    const cli = makeTransport({
      deleteSprite: async () => {
        throw new Error('delete failed');
      },
    });
    const backend = backendWith(cli, async () => {
      throw new Error('install failed');
    });

    try {
      await backend.provision({ name: 'orphaned', image: 'agentbox/box:dev' });
      expect.fail('provision should fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).message).toContain('Sprite orphaned may remain');
      expect((error as AggregateError).errors).toEqual([
        expect.objectContaining({ message: 'install failed' }),
        expect.objectContaining({ message: 'delete failed' }),
      ]);
    }
  });

  it('rejects cross-Sprite checkpoint provisioning before creating infrastructure', async () => {
    const createSprite = vi.fn(async (name: string): Promise<SpriteDetails> => ({ name }));
    const cli = makeTransport({ createSprite });
    const backend = backendWith(cli);

    await expect(backend.provision({
      name: 'restored',
      image: 'agentbox/box:dev',
      snapshot: 'v3',
    })).rejects.toThrow('cannot seed a different Sprite');
    expect(createSprite).not.toHaveBeenCalled();
  });

  it.each([
    ['running', 'running'],
    ['warming', 'running'],
    ['warm', 'paused'],
    ['cold', 'stopped'],
    ['failed', 'stopped'],
    ['deleting', 'missing'],
    [undefined, 'running'],
  ] as const)('maps Sprite status %s to cloud state %s', (spriteStatus, expected) => {
    expect(cloudStateFromSpriteStatus(spriteStatus)).toBe(expected);
  });

  it('reports missing boxes and filters prune listings to AgentBox labels', async () => {
    const cli = makeTransport({
      getSprite: async () => null,
      listSprites: async () => [
        {
          name: 'ours',
          status: 'warm',
          labels: ['agentbox'],
          created_at: '2026-08-24T00:00:00.000Z',
        },
        { name: 'personal', status: 'cold' },
      ],
    });
    const backend = backendWith(cli);
    const handle: CloudHandle = { sandboxId: 'missing' };

    await expect(backend.get('missing')).resolves.toBeNull();
    await expect(backend.state(handle)).resolves.toBe('missing');
    await expect(backend.list?.()).resolves.toEqual([
      {
        sandboxId: 'ours',
        name: 'ours',
        state: 'paused',
        createdAt: '2026-08-24T00:00:00.000Z',
      },
    ]);
  });

  it('threads cwd, environment, user, and timeout into remote execution', async () => {
    const result: SpriteExecResult = { exitCode: 7, stdout: 'out', stderr: 'err' };
    const execShell = vi.fn(async (
      _name: string,
      _command: string,
      _options?: SpriteExecOptions,
    ) => result);
    const cli = makeTransport({ execShell });
    const backend = backendWith(cli);

    await expect(backend.exec(
      { sandboxId: 'box' },
      'run-command',
      {
        cwd: '/workspace/path',
        env: { KEY: 'value' },
        user: 'runner',
        attemptTimeoutMs: 5_000,
      },
    )).resolves.toEqual(result);
    expect(execShell).toHaveBeenCalledWith('box', 'run-command', {
      cwd: '/workspace/path',
      env: { KEY: 'value' },
      user: 'runner',
      timeoutMs: 5_000,
    });
  });

  it('hands uploaded files to the vscode runtime user', async () => {
    const uploadFile = vi.fn(async () => undefined);
    const execArgv = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const cli = makeTransport({ uploadFile, execArgv });
    const backend = backendWith(cli);

    await backend.uploadFile(
      { sandboxId: 'box' },
      '/host/workspace.tar.gz',
      '/tmp/agentbox-workspace.tar.gz',
    );

    expect(uploadFile).toHaveBeenCalledWith(
      'box',
      '/host/workspace.tar.gz',
      '/tmp/agentbox-workspace.tar.gz',
    );
    expect(execArgv).toHaveBeenCalledWith(
      'box',
      [
        'sudo',
        '-n',
        'chown',
        'vscode:vscode',
        '--',
        '/tmp/agentbox-workspace.tar.gz',
      ],
      30_000,
    );
  });

  it('pauses Sprites and provides authenticated browser previews', async () => {
    const pauseSprite = vi.fn(async () => undefined);
    const refreshPreviewUrl = vi.fn(async () => 'http://127.0.0.1:5001');
    const cli = makeTransport({
      pauseSprite,
      refreshPreviewUrl,
      getSprite: async (name) => ({
        name,
        status: 'running',
        url: 'https://box-example.sprites.app',
      }),
    });
    const backend = backendWith(cli);
    const handle: CloudHandle = { sandboxId: 'box' };

    await backend.pause(handle);
    expect(pauseSprite).toHaveBeenCalledWith('box');
    await expect(backend.signedPreviewUrl?.(handle, 8080, 3600)).resolves.toEqual({
      url: 'https://box-example.sprites.app',
    });
    await expect(backend.refreshPreviewUrl?.(handle, 8080)).resolves.toEqual({
      url: 'http://127.0.0.1:5001',
    });
  });
});

describe('remote execution and attach arguments', () => {
  it('keeps commands and environment secrets out of host-visible argv', () => {
    const invocation = buildRemoteExecInvocation('printf done', {
      cwd: "/workspace/a'b",
      env: { MESSAGE: 'canary-secret spaces,quotes=stay literal' },
      user: 'vscode',
    });

    expect(invocation.argv).toEqual([
      'sudo',
      '-n',
      '-E',
      '-u',
      'vscode',
      '-H',
      'bash',
      '-l',
      '-s',
      '--',
    ]);
    expect(invocation.argv.join(' ')).not.toContain('canary-secret');
    expect(invocation.input).toBe(
      'set -e\n' +
      "export MESSAGE='canary-secret spaces,quotes=stay literal'\n" +
      "cd -- '/workspace/a'\"'\"'b'\n" +
      'printf done\n',
    );
  });

  it('refuses environment and user strings that could become command options', () => {
    expect(() => buildRemoteExecInvocation('true', { env: { 'BAD-NAME': 'x' } }))
      .toThrow('invalid environment variable name');
    expect(() => buildRemoteExecInvocation('true', { user: '--preserve-env' }))
      .toThrow('invalid remote user');
  });

  it('allocates a TTY only for interactive attach modes', () => {
    const interactive = buildSpritesAttach('sprite', 'box', 'shell');
    const detached = buildSpritesAttach('sprite', 'box', 'agent', { detached: true });
    const logs = buildSpritesAttach('sprite', 'box', 'logs');

    expect(interactive.argv).toContain('--tty');
    expect(detached.argv).not.toContain('--tty');
    expect(logs.argv).not.toContain('--tty');
    expect(interactive.argv.slice(0, 6)).toEqual([
      'sprite',
      'exec',
      '--sprite',
      'box',
      '--no-port-forward',
      '--tty',
    ]);
  });

  it('attaches as the box user, not the platform sprite user', () => {
    for (const spec of [
      buildSpritesAttach('sprite', 'box', 'shell'),
      buildSpritesAttach('sprite', 'box', 'agent', { detached: true }),
      buildSpritesAttach('sprite', 'box', 'logs'),
    ]) {
      const after = spec.argv.slice(spec.argv.indexOf('--') + 1);
      expect(after.slice(0, 6)).toEqual(['sudo', '-n', '-E', '-u', 'vscode', '-H']);
    }
  });
});
