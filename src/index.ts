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
      // Reported, not re-gated. AgentBox refuses a plugin whose
      // `agentbox.providerApiVersion` is outside its supported set before this
      // module is ever imported, so a second hardcoded comparison here can only
      // go stale — which is exactly what it did across the v2 -> v4 change.
      label: 'provider SDK',
      status: 'ok',
      detail: `API v${String(SDK_API_VERSION)}`,
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
