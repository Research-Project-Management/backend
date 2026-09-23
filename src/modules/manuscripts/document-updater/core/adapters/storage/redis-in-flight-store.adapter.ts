/**
 * document-updater/core/adapters/storage/redis-in-flight-store.adapter.ts
 * Driven Adapter implementing IInFlightStorePort with Redis (ioredis via RedisCacheService).
 * Supports multi-pod horizontal scaling and state survival across application restarts.
 */

import { Injectable, Logger } from '@nestjs/common';
import { IInFlightStorePort } from '../../ports/in-flight-store.port';
import { InFlightDoc } from '../../domain/entities/in-flight-doc.entity';
import { DocumentVersionVo } from '../../domain/value-objects/document-version.vo';
import { FlushStatusVo, FlushStatusEnum } from '../../domain/value-objects/flush-status.vo';
import { RedisCacheService } from '@/core/cache/redis.service';

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
export class RedisInFlightStoreAdapter extends IInFlightStorePort {
  private readonly logger = new Logger(RedisInFlightStoreAdapter.name);
  private readonly memoryFallback = new Map<string, InFlightDoc>();
  private readonly dirtyMemory = new Map<string, Set<string>>();

  constructor(private readonly redisService: RedisCacheService) {
    super();
  }

  private docKey(projectId: string, docId: string): string {
    return `docupdater:doc:${projectId}:${docId}`;
  }

  private dirtySetKey(projectId: string): string {
    return `docupdater:dirty:${projectId}`;
  }

  public async get(projectId: string, docId: string): Promise<InFlightDoc | null> {
    try {
      const data = await this.redisService.get<SerializedInFlightDoc>(this.docKey(projectId, docId));
      if (!data) return null;

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
    } catch {
      return this.memoryFallback.get(`${projectId}:${docId}`) ?? null;
    }
  }

  public async save(doc: InFlightDoc): Promise<void> {
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
      // Retain in Redis with 24 hours TTL
      await this.redisService.set(this.docKey(doc.projectId, doc.docId), serialized, 86400);

      const redisClient = this.redisService.getClient();
      if (redisClient) {
        if (doc.isDirty) {
          await redisClient.sadd(this.dirtySetKey(doc.projectId), doc.docId);
        } else {
          await redisClient.srem(this.dirtySetKey(doc.projectId), doc.docId);
        }
      }
    } catch {
      // Memory fallback
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
    }
  }

  public async delete(projectId: string, docId: string): Promise<void> {
    try {
      await this.redisService.del(this.docKey(projectId, docId));
      const redisClient = this.redisService.getClient();
      if (redisClient) {
        await redisClient.srem(this.dirtySetKey(projectId), docId);
      }
    } catch {
      this.memoryFallback.delete(`${projectId}:${docId}`);
      this.dirtyMemory.get(projectId)?.delete(docId);
    }
  }

  public async getDirtyDocIds(projectId: string): Promise<string[]> {
    try {
      const redisClient = this.redisService.getClient();
      if (redisClient) {
        return await redisClient.smembers(this.dirtySetKey(projectId));
      }
    } catch {
      // Fallback below
    }
    const memSet = this.dirtyMemory.get(projectId);
    return memSet ? Array.from(memSet) : [];
  }

  public async getAllProjectIds(): Promise<string[]> {
    try {
      const redisClient = this.redisService.getClient();
      if (redisClient) {
        const keys: string[] = await redisClient.keys('docupdater:dirty:*');
        return keys.map((k: string) => k.replace('docupdater:dirty:', ''));
      }
    } catch {
      // Fallback
    }
    return Array.from(this.dirtyMemory.keys());
  }

  public async clear(): Promise<void> {
    try {
      await this.redisService.delPattern('docupdater:*');
    } catch {
      // ignore
    }
    this.memoryFallback.clear();
    this.dirtyMemory.clear();
  }
}
