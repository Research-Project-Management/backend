/**
 * document-updater/document-updater.repository.ts
 * Direct @Injectable() Repository for Manuscripts Document Updater.
 *
 * Encapsulates:
 * - In-flight document buffer seam (Redis via RedisCacheService + in-memory Map fallback)
 * - Distributed & local mutex lock seam (Redis SET NX PX + in-memory TTL lock fallback)
 * - Debounce timer scheduling (Node.js setTimeout / clearTimeout)
 * - Persistent Docstore baseline hydration & OCC commit via DocstoreService
 */

import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { RedisCacheService } from '@/core';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import {
  DocModifiedError,
  DocNotFoundError,
} from '@/modules/manuscripts/docstore/domain';
import { IInFlightStorePort } from './core/ports/in-flight-store.port';
import { BaseDocData, CommitResult } from './core/ports/docstore-writer.port';
import { InFlightDoc } from './core/domain/entities/in-flight-doc.entity';
import { DocumentVersionVo } from './core/domain/value-objects/document-version.vo';
import {
  FlushStatusVo,
  FlushStatusEnum,
} from './core/domain/value-objects/flush-status.vo';
import { DocUpdaterConflictException } from './core/domain/exceptions/doc-updater-conflict.exception';

interface SerializedInFlightDoc {
  docId: string;
  projectId: string;
  lines: string[];
  rev: number;
  inFlightSeq: number;
  status: FlushStatusEnum;
  pendingOpsCount: number;
  lastUpdateTimestamp: number;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class DocumentUpdaterRepository
  extends IInFlightStorePort
  implements OnModuleDestroy
{
  private readonly logger = new Logger(DocumentUpdaterRepository.name);
  private readonly memoryFallback = new Map<string, InFlightDoc>();
  private readonly dirtyMemory = new Map<string, Set<string>>();
  private readonly lockMemory = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    @Optional() private readonly redisService?: RedisCacheService,
    @Optional() private readonly docstoreService?: DocstoreService,
  ) {
    super();
  }

  private docKey(projectId: string, docId: string): string {
    return `docupdater:doc:${projectId}:${docId}`;
  }

  private dirtySetKey(projectId: string): string {
    return `docupdater:dirty:${projectId}`;
  }

  private lockKey(resourceKey: string): string {
    return `docupdater:lock:${resourceKey}`;
  }

  // ─── In-Flight Store (Redis + In-Memory Seam) ───────────────────────────────

  public async get(
    projectId: string,
    docId: string,
  ): Promise<InFlightDoc | null> {
    if (this.redisService) {
      try {
        const data = await this.redisService.get<SerializedInFlightDoc>(
          this.docKey(projectId, docId),
        );
        if (data) {
          return InFlightDoc.create({
            docId: data.docId,
            projectId: data.projectId,
            lines: data.lines,
            version: DocumentVersionVo.of(data.rev, data.inFlightSeq),
            status: FlushStatusVo.from(data.status),
            pendingOpsCount: data.pendingOpsCount,
            lastUpdateTimestamp: data.lastUpdateTimestamp,
            createdAt: new Date(data.createdAt),
            updatedAt: new Date(data.updatedAt),
          });
        }
        return this.memoryFallback.get(`${projectId}:${docId}`) ?? null;
      } catch {
        // Fallback below
      }
    }
    return this.memoryFallback.get(`${projectId}:${docId}`) ?? null;
  }

  public async save(doc: InFlightDoc): Promise<void> {
    this.memoryFallback.set(`${doc.projectId}:${doc.docId}`, doc);
    let s = this.dirtyMemory.get(doc.projectId);
    if (!s) {
      s = new Set();
      this.dirtyMemory.set(doc.projectId, s);
    }
    if (doc.isDirty) {
      s.add(doc.docId);
    } else {
      s.delete(doc.docId);
    }

    if (!this.redisService) return;

    const serialized: SerializedInFlightDoc = {
      docId: doc.docId,
      projectId: doc.projectId,
      lines: doc.lines,
      rev: doc.rev,
      inFlightSeq: doc.inFlightSeq,
      status: doc.status.value,
      pendingOpsCount: doc.pendingOpsCount,
      lastUpdateTimestamp: doc.lastUpdateTimestamp,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };

    try {
      await this.redisService.set(
        this.docKey(doc.projectId, doc.docId),
        serialized,
        86400,
      );

      const redisClient = this.redisService.getClient();
      if (redisClient) {
        if (doc.isDirty) {
          await redisClient.sadd(this.dirtySetKey(doc.projectId), doc.docId);
        } else {
          await redisClient.srem(this.dirtySetKey(doc.projectId), doc.docId);
        }
      }
    } catch {
      // Already stored in memoryFallback
    }
  }

  public async delete(projectId: string, docId: string): Promise<void> {
    this.memoryFallback.delete(`${projectId}:${docId}`);
    this.dirtyMemory.get(projectId)?.delete(docId);

    if (!this.redisService) return;
    try {
      await this.redisService.del(this.docKey(projectId, docId));
      const redisClient = this.redisService.getClient();
      if (redisClient) {
        await redisClient.srem(this.dirtySetKey(projectId), docId);
      }
    } catch {
      // Ignore Redis error on delete
    }
  }

  public async getDirtyDocIds(projectId: string): Promise<string[]> {
    if (this.redisService) {
      try {
        const redisClient = this.redisService.getClient();
        if (redisClient) {
          const members = await redisClient.smembers(
            this.dirtySetKey(projectId),
          );
          if (members && members.length > 0) return members;
        }
      } catch {
        // Fallback below
      }
    }
    const memSet = this.dirtyMemory.get(projectId);
    return memSet ? Array.from(memSet) : [];
  }

  public async getAllProjectIds(): Promise<string[]> {
    if (this.redisService) {
      try {
        const redisClient = this.redisService.getClient();
        if (redisClient) {
          const keys: string[] = await redisClient.keys('docupdater:dirty:*');
          if (keys.length > 0) {
            return keys.map((k: string) => k.replace('docupdater:dirty:', ''));
          }
        }
      } catch {
        // Fallback
      }
    }
    return Array.from(this.dirtyMemory.keys());
  }

  public async clear(): Promise<void> {
    if (this.redisService) {
      try {
        await this.redisService.delPattern('docupdater:*');
      } catch {
        // ignore
      }
    }
    this.memoryFallback.clear();
    this.dirtyMemory.clear();
  }

  // ─── Distributed & Local Lock Seam ──────────────────────────────────────────

  public async acquireLock(
    resourceKey: string,
    ttlMs = 15000,
  ): Promise<boolean> {
    if (this.redisService) {
      try {
        const client = this.redisService.getClient();
        if (client) {
          const result = await client.set(
            this.lockKey(resourceKey),
            'locked',
            'PX',
            ttlMs,
            'NX',
          );
          return result === 'OK';
        }
      } catch {
        // Fallback below
      }
    }

    const now = Date.now();
    const existing = this.lockMemory.get(resourceKey);
    if (existing && existing > now) {
      return false;
    }
    this.lockMemory.set(resourceKey, now + ttlMs);
    return true;
  }

  public async releaseLock(resourceKey: string): Promise<void> {
    if (this.redisService) {
      try {
        const client = this.redisService.getClient();
        if (client) {
          await client.del(this.lockKey(resourceKey));
        }
      } catch {
        // Fallback
      }
    }
    this.lockMemory.delete(resourceKey);
  }

  public async isLocked(resourceKey: string): Promise<boolean> {
    if (this.redisService) {
      try {
        const client = this.redisService.getClient();
        if (client) {
          const val = await client.get(this.lockKey(resourceKey));
          return val !== null;
        }
      } catch {
        // Fallback
      }
    }
    const exp = this.lockMemory.get(resourceKey);
    return Boolean(exp && exp > Date.now());
  }

  // ─── Docstore Baseline & OCC Commit ─────────────────────────────────────────

  public async fetchBaseDoc(
    projectId: string,
    docId: string,
  ): Promise<BaseDocData | null> {
    if (!this.docstoreService) return null;
    try {
      const doc = await this.docstoreService.getDoc(projectId, docId);
      return {
        docId: doc._id,
        projectId,
        lines: doc.lines,
        rev: doc.rev,
        version: doc.version,
      };
    } catch (err) {
      if (err instanceof DocNotFoundError) {
        return null;
      }
      throw err;
    }
  }

  public async commitDocUpdate(
    projectId: string,
    docId: string,
    lines: string[],
    rev: number,
  ): Promise<CommitResult> {
    if (!this.docstoreService) {
      return {
        docId,
        newRev: rev + 1,
        version: rev + 1,
        hash: '',
      };
    }
    try {
      const result = await this.docstoreService.updateDoc(projectId, docId, {
        lines,
        expectedRev: rev,
      });

      return {
        docId,
        newRev: result.doc.rev,
        version: result.doc.version,
        hash: result.doc.hash,
      };
    } catch (err) {
      if (err instanceof DocModifiedError) {
        const expected = err.details?.rev ?? rev;
        const actual = err.details?.currentRev ?? rev + 1;
        throw new DocUpdaterConflictException(docId, expected, actual);
      }
      throw err;
    }
  }

  // ─── Debounce Timer Scheduling ──────────────────────────────────────────────

  public scheduleDebounce(
    projectId: string,
    docId: string,
    delayMs: number,
    callback: () => Promise<void>,
  ): void {
    const key = `${projectId}:${docId}`;
    this.cancelDebounce(projectId, docId);

    const timer = setTimeout(async () => {
      this.timers.delete(key);
      try {
        await callback();
      } catch (err) {
        this.logger.error(
          `Debounced flush failed for doc '${docId}' in project '${projectId}': ${(err as Error).message}`,
        );
      }
    }, delayMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    this.timers.set(key, timer);
  }

  public cancelDebounce(projectId: string, docId: string): void {
    const key = `${projectId}:${docId}`;
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(key);
    }
  }

  public cancelAllProjectDebounces(projectId: string): void {
    const prefix = `${projectId}:`;
    for (const [k, t] of this.timers.entries()) {
      if (k.startsWith(prefix)) {
        clearTimeout(t);
        this.timers.delete(k);
      }
    }
  }

  public cancelAllDebounces(): void {
    for (const t of this.timers.values()) {
      clearTimeout(t);
    }
    this.timers.clear();
  }

  public onModuleDestroy(): void {
    this.cancelAllDebounces();
  }
}
