import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  isSpritePaused,
  markSpriteActive,
  markSpritePaused,
  withSpriteTransition,
} from '../src/pause-state.js';

function lifecycleLockPath(spriteName: string): string {
  const key = createHash('sha256').update(spriteName).digest('hex');
  return resolve(homedir(), '.agentbox', 'sprites-locks', key);
}

describe('cross-process lifecycle fence', () => {
  it('serializes transitions for one Sprite', async () => {
    const spriteName = `unit-lock-${String(process.pid)}-${String(Date.now())}`;
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let reportFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      reportFirstStarted = resolve;
    });

    const first = withSpriteTransition(spriteName, async () => {
      order.push('first:start');
      reportFirstStarted?.();
      await firstGate;
      order.push('first:end');
    });
    await firstStarted;
    const second = withSpriteTransition(spriteName, async () => {
      order.push('second:start');
      order.push('second:end');
    });

    await delay(100);
    expect(order).toEqual(['first:start']);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('keeps simultaneous dead-owner reclaimers mutually exclusive', async () => {
    const spriteName = `unit-dead-owner-${String(process.pid)}-${String(Date.now())}`;
    const lock = lifecycleLockPath(spriteName);
    mkdirSync(resolve(lock, 'owner-2147483647-dead'), { recursive: true, mode: 0o700 });
    let active = 0;
    let maximumActive = 0;
    let entered = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    let reportEntered: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolveEntered) => {
      reportEntered = resolveEntered;
    });
    const operation = async (): Promise<void> => {
      active += 1;
      entered += 1;
      maximumActive = Math.max(maximumActive, active);
      if (entered === 1) reportEntered?.();
      await gate;
      active -= 1;
    };

    try {
      const transitions = [
        withSpriteTransition(spriteName, operation),
        withSpriteTransition(spriteName, operation),
      ];
      await firstEntered;
      await delay(100);
      expect(maximumActive).toBe(1);
      release?.();
      await Promise.all(transitions);
      expect(entered).toBe(2);
      expect(maximumActive).toBe(1);
    } finally {
      release?.();
      rmSync(lock, { recursive: true, force: true });
    }
  });

  it('recovers an ownerless acquisition container', async () => {
    const spriteName = `unit-ownerless-${String(process.pid)}-${String(Date.now())}`;
    const lock = lifecycleLockPath(spriteName);
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    try {
      await expect(withSpriteTransition(spriteName, async () => 'acquired'))
        .resolves.toBe('acquired');
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  });

  it('publishes and removes the shared pause fence', () => {
    const spriteName = `unit-marker-${String(process.pid)}-${String(Date.now())}`;
    try {
      markSpritePaused(spriteName);
      expect(isSpritePaused(spriteName)).toBe(true);
    } finally {
      markSpriteActive(spriteName);
    }
    expect(isSpritePaused(spriteName)).toBe(false);
  });
});
