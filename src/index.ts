import {
  SDK_API_VERSION,
  errSummary,
  type CheckResult,
  type ProviderModule,
} from '@madarco/agentbox-provider-sdk';
import { createSpritesBackend } from './backend.js';
import {
  ensureSpritesCredentials,
  loadSpriteToken,
  readSpritesCredentialStatus,
  setSpritesCredentials,
} from './credentials.js';
import { createSpritesProvider } from './provider.js';

loadSpriteToken();

const { backend: spritesBackend, cli: spritesCli } = createSpritesBackend();
const spritesProvider = createSpritesProvider(spritesBackend, spritesCli);

async function doctorChecks(): Promise<CheckResult[]> {
  const checks: CheckResult[] = [
    {
      label: 'provider SDK',
      status: SDK_API_VERSION === 2 ? 'ok' : 'fail',
      detail: `API v${String(SDK_API_VERSION)}`,
      ...(SDK_API_VERSION === 2 ? {} : { hint: 'Install a provider build matching AgentBox API v2.' }),
    },
  ];

  try {
    checks.push({
      label: 'sprite CLI',
      status: 'ok',
      detail: await spritesCli.version(),
    });
  } catch (error) {
    checks.push({
      label: 'sprite CLI',
      status: 'fail',
      detail: errSummary(error),
      hint: 'Install it with: curl -fsSL https://sprites.dev/install.sh | sh',
    });
    return checks;
  }

  const credentials = await readSpritesCredentialStatus(spritesCli);
  checks.push(credentials.configured
    ? { label: 'credentials', status: 'ok', detail: credentials.label ?? 'configured' }
    : {
        label: 'credentials',
        status: 'warn',
        detail: 'not configured',
        hint: 'Run `sprite login` or set SPRITE_TOKEN.',
      });
  checks.push({
    label: 'capabilities',
    status: 'info',
    detail: 'persistent filesystem, CLI attach, private port proxy; VNC and cross-Sprite snapshots unavailable',
  });
  return checks;
}

export const providerModule: ProviderModule = {
  provider: spritesProvider,
  backend: spritesBackend,
  ensureCredentials: (options) => ensureSpritesCredentials(spritesCli, options),
  readCredStatus: () => readSpritesCredentialStatus(spritesCli),
  setCredentials: (fields) => setSpritesCredentials(spritesCli, fields),
  doctorChecks,
};

export {
  SDK_API_VERSION,
  createSpritesBackend,
  createSpritesProvider,
  ensureSpritesCredentials,
  readSpritesCredentialStatus,
  setSpritesCredentials,
};
export {
  SPRITES_PROVIDER_NAME,
  SPRITES_RESOURCES,
  SPRITES_WEB_PROXY_PORT,
  cloudStateFromSpriteStatus,
} from './backend.js';
export { SpritesCli, SpritesApiError } from './cli.js';
export { buildSpritesAttach } from './provider.js';
export type {
  SpriteDetails,
  SpriteExecOptions,
  SpriteExecResult,
  SpritesTransport,
} from './cli.js';
