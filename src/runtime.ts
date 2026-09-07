import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveSharedRuntimeAsset,
  SHARED_RUNTIME_ASSETS,
} from '@madarco/agentbox-provider-sdk';
import type { SpritesTransport } from './cli.js';

const REMOTE_RUNTIME_DIR = '/tmp/agentbox-runtime';
// Taken from the SDK rather than pinned here. The CLI's shared-asset set moves
// with the CLI - `ntn-shim` and `linear-shim` went away with the notion/linear
// connectors, and `agentbox-tool-shim` replaced them - and any literal copy of
// the list fails the whole create the moment one entry is renamed or dropped.
const SHARED_ASSETS = SHARED_RUNTIME_ASSETS;

export interface ResolvedRuntime {
  localFiles: string[];
  remoteInstaller: string;
}

export function resolveSpritesRuntime(): ResolvedRuntime {
  const self = dirname(fileURLToPath(import.meta.url));
  const installerCandidates = [
    resolve(self, '..', 'scripts', 'install-box.sh'),
    resolve(self, 'scripts', 'install-box.sh'),
  ];
  const installer = installerCandidates.find((candidate) => existsSync(candidate));
  if (!installer) {
    throw new Error(
      `sprites provider install-box.sh is missing (tried ${installerCandidates.join(', ')})`,
    );
  }

  return {
    localFiles: [installer, ...SHARED_ASSETS.map((asset) => resolveSharedRuntimeAsset(asset))],
    remoteInstaller: `${REMOTE_RUNTIME_DIR}/install-box.sh`,
  };
}

export async function installSpritesRuntime(
  cli: Pick<SpritesTransport, 'uploadFiles' | 'execArgv'>,
  spriteName: string,
  runtime: ResolvedRuntime,
  onLog: (line: string) => void = () => undefined,
): Promise<void> {
  onLog('uploading AgentBox runtime');
  await cli.uploadFiles(spriteName, runtime.localFiles, `${REMOTE_RUNTIME_DIR}/`);

  const result = await cli.execArgv(
    spriteName,
    ['sudo', '-n', 'bash', runtime.remoteInstaller],
    120_000,
  );
  for (const line of result.stdout.split('\n')) {
    if (line.trim()) onLog(line);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `AgentBox runtime install failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`}`,
    );
  }
}
