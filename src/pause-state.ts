import { createHash, randomUUID } from 'node:crypto';
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 60_000;

function spriteKey(spriteName: string): string {
  return createHash('sha256').update(spriteName).digest('hex');
}

function stateDirectory(kind: 'paused' | 'locks'): string {
  return resolve(homedir(), '.agentbox', `sprites-${kind}`);
}

function markerPath(spriteName: string): string {
  return resolve(stateDirectory('paused'), spriteKey(spriteName));
}

export function markSpritePaused(spriteName: string): void {
  const path = markerPath(spriteName);
  mkdirSync(stateDirectory('paused'), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${spriteName}\n`, { mode: 0o600 });
}

export function markSpriteActive(spriteName: string): void {
  rmSync(markerPath(spriteName), { force: true });
}

export function isSpritePaused(spriteName: string): boolean {
  return existsSync(markerPath(spriteName));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function removeEmptyDirectory(path: string): void {
  try {
    rmdirSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
  }
}

function reclaimDeadOwners(lock: string): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(lock, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^owner-(\d+)-/.exec(entry.name);
    if (!match?.[1]) continue;
    const pid = Number.parseInt(match[1], 10);
    if (!Number.isSafeInteger(pid) || pid <= 0 || processIsAlive(pid)) continue;
    removeEmptyDirectory(resolve(lock, entry.name));
  }
  // Non-recursive removal is the safety property: a concurrently published
  // owner makes this fail with ENOTEMPTY instead of losing a live lock.
  removeEmptyDirectory(lock);
}

function reclaimDeadCandidates(locks: string, key: string): void {
  const prefix = `.${key}.candidate-`;
  for (const entry of readdirSync(locks, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const pidText = /^(\d+)-/.exec(entry.name.slice(prefix.length))?.[1];
    if (!pidText) continue;
    const pid = Number.parseInt(pidText, 10);
    if (!Number.isSafeInteger(pid) || pid <= 0 || processIsAlive(pid)) continue;
    rmSync(resolve(locks, entry.name), { recursive: true, force: true });
  }
}

export async function withSpriteTransition<T>(
  spriteName: string,
  operation: () => Promise<T>,
): Promise<T> {
  const locks = stateDirectory('locks');
  const key = spriteKey(spriteName);
  const lock = resolve(locks, key);
  const token = randomUUID();
  const ownerName = `owner-${String(process.pid)}-${token}`;
  const owner = resolve(lock, ownerName);
  const candidate = resolve(locks, `.${key}.candidate-${String(process.pid)}-${token}`);
  mkdirSync(locks, { recursive: true, mode: 0o700 });
  reclaimDeadCandidates(locks, key);
  mkdirSync(candidate, { mode: 0o700 });
  mkdirSync(resolve(candidate, ownerName), { mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  try {
    while (true) {
      try {
        // The owner child is already present when the fixed name appears.
        // rename is the single atomic publication point.
        renameSync(candidate, lock);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
        reclaimDeadOwners(lock);
        if (Date.now() >= deadline) {
          throw new Error(`timed out waiting for the Sprite lifecycle lock: ${spriteName}`);
        }
        await delay(LOCK_RETRY_MS);
      }
    }
  } catch (error) {
    rmSync(candidate, { recursive: true, force: true });
    throw error;
  }

  try {
    return await operation();
  } finally {
    removeEmptyDirectory(owner);
    removeEmptyDirectory(lock);
  }
}
