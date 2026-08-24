import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SpritesCli } from '../src/cli.js';
import { markSpriteActive, markSpritePaused } from '../src/pause-state.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fakeSpriteCli(): { cli: SpritesCli; capturePath: string } {
  const directory = mkdtempSync(resolve(tmpdir(), 'agentbox-sprites-cli-'));
  temporaryDirectories.push(directory);
  const binary = resolve(directory, 'sprite.mjs');
  const capturePath = resolve(directory, 'capture.json');
  writeFileSync(binary, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
let input = '';
if (argv.includes('@-') || (argv[0] === 'exec' && argv.includes('-s'))) {
  for await (const chunk of process.stdin) input += chunk.toString('utf8');
}
writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ argv, input }));
if (argv[0] === 'api') {
  process.stdout.write('{"name":"unit-secret-box","status":"cold"}\\n__AGENTBOX_SPRITES_HTTP_STATUS__:201');
}
`);
  chmodSync(binary, 0o755);
  return { cli: new SpritesCli({ binary, cwd: directory }), capturePath };
}

function captured(path: string): { argv: string[]; input: string } {
  return JSON.parse(readFileSync(path, 'utf8')) as { argv: string[]; input: string };
}

describe('sprite child-process boundary', () => {
  it('streams API and remote-exec secrets over stdin instead of argv', async () => {
    const { cli, capturePath } = fakeSpriteCli();
    const secret = 'canary-api-secret';

    await cli.createSprite('unit-secret-box', {
      environment: { AGENTBOX_RELAY_TOKEN: secret },
    });
    const apiCall = captured(capturePath);
    expect(apiCall.argv.join(' ')).not.toContain(secret);
    expect(apiCall.argv).toContain('@-');
    expect(JSON.parse(apiCall.input)).toEqual(expect.objectContaining({
      environment: { AGENTBOX_RELAY_TOKEN: secret },
    }));

    await cli.execShell('unit-secret-box', `printf '%s' ${secret}`, {
      env: { PRIVATE_VALUE: secret },
    });
    const execCall = captured(capturePath);
    expect(execCall.argv.join(' ')).not.toContain(secret);
    expect(execCall.input).toContain(secret);
    expect(execCall.argv.slice(-10)).toEqual([
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
  });

  it('terminates file-command options before dash-prefixed paths', async () => {
    const { cli, capturePath } = fakeSpriteCli();

    await cli.uploadFile('box', '--host-file', '--remote-file');
    expect(captured(capturePath).argv).toEqual([
      'file',
      'push',
      '--parents',
      '--sprite',
      'box',
      '--',
      '--host-file',
      '--remote-file',
    ]);

    await cli.downloadFile('box', '--remote-file', '--host-file');
    expect(captured(capturePath).argv).toEqual([
      'file',
      'pull',
      '--parents',
      '--sprite',
      'box',
      '--',
      '--remote-file',
      '--host-file',
    ]);
  });

  it('does not recreate the AgentBox service after a concurrent pause wins', async () => {
    const { cli, capturePath } = fakeSpriteCli();
    const spriteName = `paused-service-${String(process.pid)}-${String(Date.now())}`;
    markSpritePaused(spriteName);
    try {
      await expect(cli.ensureAgentboxService(spriteName))
        .rejects.toThrow('was paused before its AgentBox service could start');
      expect(existsSync(capturePath)).toBe(false);
    } finally {
      markSpriteActive(spriteName);
    }
  });
});
