/**
 * document-updater/core/adapters/lock/local-mutex-updater-lock.adapter.ts
 * Driven Adapter implementing IUpdaterLockPort using in-process async mutex map.
 */

import { Injectable } from '@nestjs/common';
import { IUpdaterLockPort } from '../../ports/updater-lock.port';

interface LockEntry {
  expiresAt: number;
}

@Injectable()
export class LocalMutexUpdaterLockAdapter extends IUpdaterLockPort {
  private readonly locks = new Map<string, LockEntry>();

  public async acquire(resourceKey: string, ttlMs = 15000): Promise<boolean> {
    const now = Date.now();
    const existing = this.locks.get(resourceKey);

    if (existing && existing.expiresAt > now) {
      return false; // Still held
    }

    this.locks.set(resourceKey, {
      expiresAt: now + ttlMs,
    });
    return true;
  }

  public async release(resourceKey: string): Promise<void> {
    this.locks.delete(resourceKey);
  }

  public async isLocked(resourceKey: string): Promise<boolean> {
    const entry = this.locks.get(resourceKey);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) {
      this.locks.delete(resourceKey);
      return false;
    }
    return true;
  }
}
