import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createServer, type Server, type Socket } from 'node:net';
import { execa } from 'execa';
import {
  isSpritePaused,
  markSpriteActive,
  markSpritePaused,
  withSpriteTransition,
} from './pause-state.js';

const API_STATUS_MARKER = '__AGENTBOX_SPRITES_HTTP_STATUS__:';
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const PROXY_IDLE_MS = 60_000;
const PROXY_PAUSE_POLL_MS = 250;
const AGENTBOX_SERVICE_NAME = 'agentbox-ctl';
const AGENTBOX_SERVICE_SCRIPT =
  'while /usr/local/bin/agentbox-ctl status >/dev/null 2>&1; do sleep 2; done; ' +
  'rm -f /run/agentbox/ctl.sock; exec /usr/local/bin/agentbox-ctl daemon';

export interface SpriteDetails {
  id?: string;
  name: string;
  organization?: string;
  status?: string;
  url?: string;
  labels?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface SpriteFileEntry {
  name: string;
  isDir: boolean;
}

export interface SpriteExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  user?: string | null;
  timeoutMs?: number;
}

export interface SpriteExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SpriteCreateOptions {
  environment?: Record<string, string>;
  labels?: string[];
}

interface ApiResult {
  status: number;
  body: string;
}

export class SpritesApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    operation: string,
  ) {
    super(`Sprites API ${operation} failed with status ${String(status)}${body ? `: ${body}` : ''}`);
    this.name = 'SpritesApiError';
  }
}

export interface SpritesTransport {
  readonly binary: string;
  version(): Promise<string>;
  login(): Promise<void>;
  hasLocalCredentials(): Promise<boolean>;
  probeCredentials(env?: NodeJS.ProcessEnv): Promise<boolean>;
  createSprite(name: string, options?: SpriteCreateOptions): Promise<SpriteDetails>;
  getSprite(name: string): Promise<SpriteDetails | null>;
  listSprites(): Promise<SpriteDetails[]>;
  deleteSprite(name: string): Promise<void>;
  wakeSprite(name: string): Promise<void>;
  pauseSprite(name: string): Promise<void>;
  execShell(name: string, command: string, options?: SpriteExecOptions): Promise<SpriteExecResult>;
  execArgv(
    name: string,
    argv: string[],
    timeoutMs?: number,
    input?: string | Buffer,
  ): Promise<SpriteExecResult>;
  uploadFile(name: string, localPath: string, remotePath: string): Promise<void>;
  uploadFiles(name: string, localPaths: string[], remoteDir: string): Promise<void>;
  downloadFile(name: string, remotePath: string, localPath: string): Promise<void>;
  listFiles(name: string, remoteDir: string): Promise<SpriteFileEntry[]>;
  previewUrl(name: string, remotePort: number): Promise<string>;
  refreshPreviewUrl(name: string, remotePort: number): Promise<string>;
  closePreviewUrls(name: string): void;
  ensureAgentboxService(name: string): Promise<void>;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function assertEnvironment(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`invalid environment variable name: ${key}`);
    }
  }
}

function assertUser(user: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*\$?$/.test(user)) {
    throw new Error(`invalid remote user: ${user}`);
  }
}

export interface RemoteExecInvocation {
  argv: string[];
  input: string;
}

export function buildRemoteExecInvocation(
  command: string,
  options: SpriteExecOptions = {},
): RemoteExecInvocation {
  const env = options.env ?? {};
  assertEnvironment(env);
  const script = [
    'set -e',
    ...Object.entries(env).map(([key, value]) => `export ${key}=${quoteShell(value)}`),
    ...(options.cwd ? [`cd -- ${quoteShell(options.cwd)}`] : []),
    command,
    '',
  ].join('\n');
  const user = options.user === undefined ? 'vscode' : options.user;
  if (user === null) return { argv: ['bash', '-l', '-s', '--'], input: script };

  assertUser(user);
  return {
    argv: ['sudo', '-n', '-E', '-u', user, '-H', 'bash', '-l', '-s', '--'],
    input: script,
  };
}

class LocalSpriteProxy {
  private server: Server | undefined;
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private closed = false;
  private idleTimer: NodeJS.Timeout | undefined;
  private pauseTimer: NodeJS.Timeout | undefined;
  private readonly closeOnExit = (): void => this.close();
  constructor(
    private readonly binary: string,
    private readonly cwd: string,
    private readonly spriteName: string,
    private readonly remotePort: number,
    private readonly paused: () => boolean,
  ) {}

  async start(): Promise<string> {
    if (this.server) throw new Error('Sprites proxy already started');

    const server = createServer((socket) => this.forward(socket));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });
    server.unref();
    server.on('error', () => this.close());
    process.once('exit', this.closeOnExit);
    this.pauseTimer = setInterval(() => {
      if (this.paused()) this.close();
    }, PROXY_PAUSE_POLL_MS);
    this.pauseTimer.unref();
    this.scheduleIdleClose();

    const address = server.address();
    if (!address || typeof address === 'string') {
      this.close();
      throw new Error('Sprites proxy did not bind a TCP port');
    }
    return `http://127.0.0.1:${String(address.port)}`;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    clearInterval(this.pauseTimer);
    this.pauseTimer = undefined;
    this.server?.close();
    this.server = undefined;
    for (const child of this.children) child.kill('SIGTERM');
    this.children.clear();
    process.off('exit', this.closeOnExit);
  }

  isClosed(): boolean {
    return this.closed;
  }

  private forward(socket: Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    if (this.paused()) {
      socket.destroy(new Error(`Sprite ${this.spriteName} is paused`));
      return;
    }

    const child = spawn(
      this.binary,
      ['proxy', '--sprite', this.spriteName, '--stdio', `:${String(this.remotePort)}`],
      {
        cwd: this.cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.children.add(child);
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    // A CLI command must be able to exit after handing the recorded URL to the
    // long-lived host relay. The relay re-opens this proxy in its own process.
    socket.unref();
    child.unref();
    (child.stdin as typeof child.stdin & { unref?: () => void }).unref?.();
    (child.stdout as typeof child.stdout & { unref?: () => void }).unref?.();
    (child.stderr as typeof child.stderr & { unref?: () => void }).unref?.();

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 8192) stderr += chunk;
    });

    socket.pipe(child.stdin);
    child.stdout.pipe(socket);

    const stopChild = (): void => {
      if (!child.killed) child.kill('SIGTERM');
    };
    socket.once('close', stopChild);
    socket.once('error', stopChild);

    child.once('error', (error) => {
      socket.destroy(error);
      this.children.delete(child);
      this.scheduleIdleClose();
    });
    child.once('close', (code) => {
      this.children.delete(child);
      this.scheduleIdleClose();
      if (!socket.destroyed) {
        if (code === 0) socket.end();
        else socket.destroy(new Error(stderr.trim() || `sprite proxy exited ${String(code)}`));
      }
    });
  }

  private scheduleIdleClose(): void {
    if (this.closed || this.children.size > 0) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), PROXY_IDLE_MS);
    this.idleTimer.unref();
  }
}

export class SpritesCli implements SpritesTransport {
  readonly binary: string;
  private readonly cwd: string;
  private readonly proxies = new Map<string, { proxy: LocalSpriteProxy; url: string }>();

  constructor(options: { binary?: string; cwd?: string } = {}) {
    this.binary = options.binary ?? 'sprite';
    this.cwd = options.cwd ?? tmpdir();
  }

  async version(): Promise<string> {
    const result = await this.run(['--version']);
    if (result.exitCode !== 0) throw this.commandError('read version', result);
    return result.stdout.trim();
  }

  async login(): Promise<void> {
    const result = await execa(this.binary, ['login'], {
      cwd: this.cwd,
      env: process.env,
      reject: false,
      stdio: 'inherit',
    });
    if (result.exitCode !== 0) {
      throw new Error(`sprite login exited with status ${String(result.exitCode)}`);
    }
  }

  async hasLocalCredentials(): Promise<boolean> {
    const result = await this.run(['org', 'list']);
    return result.exitCode === 0 && /Currently selected org:\s*\S+/.test(result.stdout);
  }

  async probeCredentials(env?: NodeJS.ProcessEnv): Promise<boolean> {
    try {
      const result = await this.api('GET', '/v1/sprites?max_results=1', undefined, env);
      return result.status >= 200 && result.status < 300;
    } catch {
      return false;
    }
  }

  async createSprite(name: string, options: SpriteCreateOptions = {}): Promise<SpriteDetails> {
    return withSpriteTransition(name, async () => {
      const sprite = await this.apiJson<SpriteDetails>('POST', '/v1/sprites', {
        name,
        wait_for_capacity: true,
        url_settings: { auth: 'sprite' },
        ...(options.environment ? { environment: options.environment } : {}),
        ...(options.labels ? { labels: options.labels } : {}),
      });
      markSpriteActive(name);
      return sprite;
    });
  }

  async getSprite(name: string): Promise<SpriteDetails | null> {
    const result = await this.api('GET', `/v1/sprites/${encodeURIComponent(name)}`);
    if (result.status === 404) return null;
    this.assertApiSuccess(result, `get ${name}`);
    return this.parseJson<SpriteDetails>(result.body, `get ${name}`);
  }

  async listSprites(): Promise<SpriteDetails[]> {
    const sprites: SpriteDetails[] = [];
    let continuationToken: string | undefined;

    do {
      const query = new URLSearchParams({ max_results: '50' });
      if (continuationToken) query.set('continuation_token', continuationToken);
      const page = await this.apiJson<{
        sprites?: SpriteDetails[];
        has_more?: boolean;
        next_continuation_token?: string | null;
      }>('GET', `/v1/sprites?${query.toString()}`);
      sprites.push(...(page.sprites ?? []));
      continuationToken = page.has_more && page.next_continuation_token
        ? page.next_continuation_token
        : undefined;
    } while (continuationToken);

    return sprites;
  }

  async deleteSprite(name: string): Promise<void> {
    await withSpriteTransition(name, async () => {
      markSpritePaused(name);
      this.closePreviewUrls(name);
      const result = await this.api('DELETE', `/v1/sprites/${encodeURIComponent(name)}`);
      if (result.status !== 404) this.assertApiSuccess(result, `delete ${name}`);
      markSpriteActive(name);
    });
  }

  async wakeSprite(name: string): Promise<void> {
    await withSpriteTransition(name, async () => {
      const result = await this.execArgv(name, ['true'], 30_000);
      if (result.exitCode !== 0) throw this.commandError(`wake ${name}`, result);
      markSpriteActive(name);
    });
  }

  async pauseSprite(name: string): Promise<void> {
    await withSpriteTransition(name, async () => {
      markSpritePaused(name);
      this.closePreviewUrls(name);

      const servicePath =
        `/v1/sprites/${encodeURIComponent(name)}/services/${AGENTBOX_SERVICE_NAME}/stop?timeout=5s`;
      const service = await this.api('POST', servicePath);
      if (service.status !== 404 && service.status !== 409) {
        this.assertApiSuccess(service, `stop ${AGENTBOX_SERVICE_NAME} service`);
      }

      const daemon = await this.execArgv(
        name,
        ['sudo', '-n', 'pkill', '-TERM', '-f', '[a]gentbox-ctl daemon'],
        30_000,
      );
      if (daemon.exitCode !== 0 && daemon.exitCode !== 1) {
        throw this.commandError(`stop ${AGENTBOX_SERVICE_NAME} daemon`, daemon);
      }
    });
  }

  async execShell(
    name: string,
    command: string,
    options: SpriteExecOptions = {},
  ): Promise<SpriteExecResult> {
    const invocation = buildRemoteExecInvocation(command, options);
    return this.execArgv(name, invocation.argv, options.timeoutMs, invocation.input);
  }

  async execArgv(
    name: string,
    argv: string[],
    timeoutMs?: number,
    input?: string | Buffer,
  ): Promise<SpriteExecResult> {
    return this.run(
      ['exec', '--sprite', name, '--no-port-forward', '--', ...argv],
      {
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(input === undefined ? {} : { input }),
      },
    );
  }

  async uploadFile(name: string, localPath: string, remotePath: string): Promise<void> {
    const result = await this.run([
      'file',
      'push',
      '--parents',
      '--sprite',
      name,
      '--',
      localPath,
      remotePath,
    ]);
    if (result.exitCode !== 0) throw this.commandError(`upload ${remotePath}`, result);
  }

  async uploadFiles(name: string, localPaths: string[], remoteDir: string): Promise<void> {
    if (localPaths.length === 0) return;
    const result = await this.run([
      'file',
      'push',
      '--parents',
      '--sprite',
      name,
      '--',
      ...localPaths,
      remoteDir,
    ]);
    if (result.exitCode !== 0) throw this.commandError(`upload runtime to ${remoteDir}`, result);
  }

  async downloadFile(name: string, remotePath: string, localPath: string): Promise<void> {
    const result = await this.run([
      'file',
      'pull',
      '--parents',
      '--sprite',
      name,
      '--',
      remotePath,
      localPath,
    ]);
    if (result.exitCode !== 0) throw this.commandError(`download ${remotePath}`, result);
  }

  async listFiles(name: string, remoteDir: string): Promise<SpriteFileEntry[]> {
    const query = new URLSearchParams({ path: remoteDir, workingDir: '/' });
    const data = await this.apiJson<{
      entries?: Array<{ name: string; isDir?: boolean; is_dir?: boolean; type?: string }>;
    }>('GET', `/v1/sprites/${encodeURIComponent(name)}/fs/list?${query.toString()}`);
    return (data.entries ?? []).map((entry) => ({
      name: entry.name,
      isDir: entry.isDir ?? entry.is_dir ?? entry.type === 'directory',
    }));
  }

  async previewUrl(name: string, remotePort: number): Promise<string> {
    if (isSpritePaused(name)) {
      this.closePreviewUrls(name);
      throw new Error(`Sprite ${name} is paused`);
    }
    const key = this.proxyKey(name, remotePort);
    const existing = this.proxies.get(key);
    if (existing && !existing.proxy.isClosed()) return existing.url;
    if (existing) this.proxies.delete(key);

    const proxy = new LocalSpriteProxy(
      this.binary,
      this.cwd,
      name,
      remotePort,
      () => isSpritePaused(name),
    );
    const url = await proxy.start();
    this.proxies.set(key, { proxy, url });
    return url;
  }

  async refreshPreviewUrl(name: string, remotePort: number): Promise<string> {
    const key = this.proxyKey(name, remotePort);
    this.proxies.get(key)?.proxy.close();
    this.proxies.delete(key);
    return this.previewUrl(name, remotePort);
  }

  closePreviewUrls(name: string): void {
    const prefix = `${name}:`;
    for (const [key, value] of this.proxies) {
      if (!key.startsWith(prefix)) continue;
      value.proxy.close();
      this.proxies.delete(key);
    }
  }

  async ensureAgentboxService(name: string): Promise<void> {
    await withSpriteTransition(name, async () => {
      if (isSpritePaused(name)) {
        throw new Error(`Sprite ${name} was paused before its AgentBox service could start`);
      }
      const path =
        `/v1/sprites/${encodeURIComponent(name)}/services/${AGENTBOX_SERVICE_NAME}?duration=2s`;
      const result = await this.api('PUT', path, {
        cmd: 'sudo',
        args: [
          '-n',
          '-E',
          '-u',
          'vscode',
          '-H',
          'bash',
          '-lc',
          AGENTBOX_SERVICE_SCRIPT,
        ],
        dir: '/workspace',
      });
      this.assertApiSuccess(result, `configure ${AGENTBOX_SERVICE_NAME} service`);
    });
  }

  private async api(
    method: string,
    path: string,
    body?: unknown,
    env?: NodeJS.ProcessEnv,
  ): Promise<ApiResult> {
    const args = [
      'api',
      path,
      '--',
      '--silent',
      '--show-error',
      '--request',
      method,
      '--write-out',
      `\n${API_STATUS_MARKER}%{http_code}`,
    ];
    const input = body === undefined ? undefined : JSON.stringify(body);
    if (input !== undefined) {
      args.push('--header', 'Content-Type: application/json', '--data-binary', '@-');
    }

    const result = await this.run(args, {
      ...(env === undefined ? {} : { env }),
      ...(input === undefined ? {} : { input }),
    });
    const markerIndex = result.stdout.lastIndexOf(API_STATUS_MARKER);
    if (markerIndex < 0) {
      throw this.commandError(`${method} ${path}`, result);
    }

    const statusText = result.stdout.slice(markerIndex + API_STATUS_MARKER.length).trim();
    const status = Number.parseInt(statusText, 10);
    if (!Number.isFinite(status)) {
      throw new Error(`sprite api returned an invalid HTTP status: ${statusText}`);
    }

    const bodyText = result.stdout.slice(0, markerIndex).replace(/\n$/, '');
    if (result.exitCode !== 0 && status === 0) {
      throw this.commandError(`${method} ${path}`, result);
    }
    return { status, body: bodyText };
  }

  private async apiJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const result = await this.api(method, path, body);
    this.assertApiSuccess(result, `${method} ${path}`);
    return this.parseJson<T>(result.body, `${method} ${path}`);
  }

  private assertApiSuccess(result: ApiResult, operation: string): void {
    if (result.status < 200 || result.status >= 300) {
      throw new SpritesApiError(result.status, result.body, operation);
    }
  }

  private parseJson<T>(body: string, operation: string): T {
    try {
      return JSON.parse(body) as T;
    } catch (error) {
      throw new Error(
        `Sprites API ${operation} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async run(
    args: string[],
    options: {
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      input?: string | Buffer;
    } = {},
  ): Promise<SpriteExecResult> {
    const result = await execa(this.binary, args, {
      cwd: this.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      reject: false,
      maxBuffer: DEFAULT_MAX_BUFFER,
      encoding: 'utf8',
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      ...(options.input === undefined ? {} : { input: options.input }),
    });
    return {
      exitCode: result.exitCode ?? (result.timedOut ? 124 : 1),
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
    };
  }

  private commandError(operation: string, result: SpriteExecResult): Error {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`;
    return new Error(`sprite ${operation} failed: ${detail}`);
  }

  private proxyKey(name: string, remotePort: number): string {
    return `${name}:${String(remotePort)}`;
  }
}
