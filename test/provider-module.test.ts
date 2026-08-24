import { SDK_API_VERSION } from '@madarco/agentbox-provider-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureSpritesCredentials,
  readSpritesCredentialStatus,
  setSpritesCredentials,
} from '../src/credentials.js';
import { providerModule } from '../src/index.js';

const originalToken = process.env.SPRITE_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.SPRITE_TOKEN;
  else process.env.SPRITE_TOKEN = originalToken;
});

describe('Sprites credentials', () => {
  it('does not launch login when configured credentials pass the API probe', async () => {
    const login = vi.fn(async () => undefined);
    const probeCredentials = vi.fn(async () => true);

    await ensureSpritesCredentials({ login, probeCredentials });

    expect(probeCredentials).toHaveBeenCalledOnce();
    expect(login).not.toHaveBeenCalled();
  });

  it('reports an environment token without exposing its value', async () => {
    process.env.SPRITE_TOKEN = 'secret-token-value';
    const status = await readSpritesCredentialStatus({
      hasLocalCredentials: async () => false,
    });

    expect(status).toEqual({ configured: true, label: 'token' });
    expect(JSON.stringify(status)).not.toContain('secret-token-value');
  });

  it('rejects missing and invalid headless tokens without persisting them', async () => {
    const probeCredentials = vi.fn(async () => false);

    await expect(setSpritesCredentials({ probeCredentials }, {})).resolves.toEqual({
      ok: false,
      error: 'token is required',
      status: { configured: false },
    });
    await expect(setSpritesCredentials({ probeCredentials }, { token: 'invalid' })).resolves.toEqual({
      ok: false,
      error: 'Sprites rejected the token',
      status: { configured: false },
    });
    expect(process.env.SPRITE_TOKEN).toBe(originalToken);
  });
});

describe('provider module', () => {
  it('exports the API v2 provider, backend, diagnostics, and credential hooks', () => {
    expect(SDK_API_VERSION).toBe(2);
    expect(providerModule.provider.name).toBe('sprites');
    expect(providerModule.backend?.name).toBe('sprites');
    expect(providerModule.doctorChecks).toBeTypeOf('function');
    expect(providerModule.ensureCredentials).toBeTypeOf('function');
    expect(providerModule.readCredStatus).toBeTypeOf('function');
    expect(providerModule.setCredentials).toBeTypeOf('function');
  });
});
