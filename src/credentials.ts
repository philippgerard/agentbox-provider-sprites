import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { CredStatusSummary } from '@madarco/agentbox-provider-sdk';
import type { SpritesTransport } from './cli.js';

const TOKEN_KEY = 'SPRITE_TOKEN';
const TOKEN_LINE = /^\s*(?:export\s+)?SPRITE_TOKEN\s*=/;

export interface CredentialSetResult {
  ok: boolean;
  error?: string;
  status: CredStatusSummary;
}

export function spritesSecretsPath(): string {
  return resolve(homedir(), '.agentbox', 'secrets.env');
}

function decodeEnvValue(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll(`'"'"'`, "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function loadSpriteToken(): void {
  if (process.env[TOKEN_KEY]) return;
  const path = spritesSecretsPath();
  if (!existsSync(path)) return;

  const line = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .find((candidate) => TOKEN_LINE.test(candidate));
  if (!line) return;

  const separator = line.indexOf('=');
  const token = separator >= 0 ? decodeEnvValue(line.slice(separator + 1)) : '';
  if (token) process.env[TOKEN_KEY] = token;
}

function persistSpriteToken(token: string): void {
  const path = spritesSecretsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const existing = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  const lines = existing.filter((line) => line.length > 0 && !TOKEN_LINE.test(line));
  const escaped = token.replaceAll("'", `'"'"'`);
  lines.push(`${TOKEN_KEY}='${escaped}'`);

  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${lines.join('\n')}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  process.env[TOKEN_KEY] = token;
}

export async function ensureSpritesCredentials(
  cli: Pick<SpritesTransport, 'probeCredentials' | 'login'>,
  options: { force?: boolean } = {},
): Promise<void> {
  loadSpriteToken();
  if (!options.force && await cli.probeCredentials()) return;

  if (!process.stdin.isTTY) {
    throw new Error(
      'Sprites credentials are not configured. Run `sprite login` or set SPRITE_TOKEN, then retry.',
    );
  }

  await cli.login();
  if (!await cli.probeCredentials()) {
    throw new Error('sprite login completed, but the Sprites API still rejected the credentials');
  }
}

export async function readSpritesCredentialStatus(
  cli: Pick<SpritesTransport, 'hasLocalCredentials'>,
): Promise<CredStatusSummary> {
  loadSpriteToken();
  if (process.env[TOKEN_KEY]) return { configured: true, label: 'token' };
  return await cli.hasLocalCredentials()
    ? { configured: true, label: 'sprite CLI' }
    : { configured: false };
}

export async function setSpritesCredentials(
  cli: Pick<SpritesTransport, 'probeCredentials'>,
  fields: Record<string, string>,
): Promise<CredentialSetResult> {
  const token = (fields.token ?? fields.apiToken ?? '').trim();
  if (!token) {
    return {
      ok: false,
      error: 'token is required',
      status: { configured: false },
    };
  }

  const valid = await cli.probeCredentials({ SPRITE_TOKEN: token });
  if (!valid) {
    return {
      ok: false,
      error: 'Sprites rejected the token',
      status: { configured: false },
    };
  }

  persistSpriteToken(token);
  return { ok: true, status: { configured: true, label: 'token' } };
}
