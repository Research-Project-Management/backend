/**
 * linked-files/linked-files.repository.ts
 * Direct @Injectable() Repository for Manuscripts Linked Files.
 *
 * Implements write-through persistence to the Prisma `ManuscriptLinkedFile` model
 * combined with Redis cache-aside (hash storage) and bounded in-memory LRU fallback.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '@/core/infrastructure/database/prisma.service';
import { RedisCacheService } from '@/core/infrastructure/redis/redis.service';
import type Redis from 'ioredis';
import {
  ILinkedFilesRepositoryPort,
  LinkedFileEntity,
  LinkedFileProps,
  LinkedFileJSON,
} from './domain';

@Injectable()
export class LinkedFilesRepository extends ILinkedFilesRepositoryPort {
  private readonly logger = new Logger(LinkedFilesRepository.name);
  private static readonly MAX_MEMORY_PROJECTS = 1000;
  private static readonly MAX_FILES_PER_PROJECT = 500;
  private readonly memoryStore = new Map<
    string,
    Map<string, LinkedFileEntity>
  >();

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly redis?: RedisCacheService,
  ) {
    super();
  }

  private saveToMemoryStore(entity: LinkedFileEntity): void {
    let projectMap = this.memoryStore.get(entity.projectId);
    if (!projectMap) {
      if (this.memoryStore.size >= LinkedFilesRepository.MAX_MEMORY_PROJECTS) {
        const oldestProject = this.memoryStore.keys().next().value;
        if (oldestProject !== undefined) {
          this.memoryStore.delete(oldestProject);
        }
      }
      projectMap = new Map();
      this.memoryStore.set(entity.projectId, projectMap);
    }
    if (
      !projectMap.has(entity.id) &&
      projectMap.size >= LinkedFilesRepository.MAX_FILES_PER_PROJECT
    ) {
      const oldestFileId = projectMap.keys().next().value;
      if (oldestFileId !== undefined) {
        projectMap.delete(oldestFileId);
      }
    }
    projectMap.set(entity.id, entity);
  }

  private getRedisClient(): Redis | null {
    if (this.redis && this.redis.isReady()) {
      return this.redis.getClient();
    }
    return null;
  }

  private projectKey(projectId: string): string {
    return `manuscript:linked_files:${projectId}`;
  }

  public async save(entity: LinkedFileEntity): Promise<LinkedFileEntity> {
    // 1. In-memory update
    this.saveToMemoryStore(entity);

    // 2. Write-through to Prisma DB
    if (this.prisma) {
      try {
        await this.prisma.manuscriptLinkedFile.upsert({
          where: { id: entity.id },
          create: {
            id: entity.id,
            projectId: entity.projectId,
            name: entity.name,
            provider: entity.provider,
            url: entity.url ?? null,
            targetDocId: entity.docId ?? null,
            targetFileId: entity.fileId ?? null,
            targetPath: entity.nodeId ?? entity.name,
            lastSyncedAt: entity.lastSyncedAt ?? null,
            syncError: entity.errorMessage ?? null,
            createdAt: entity.createdAt,
            updatedAt: entity.updatedAt,
          },
          update: {
            name: entity.name,
            provider: entity.provider,
            url: entity.url ?? null,
            targetDocId: entity.docId ?? null,
            targetFileId: entity.fileId ?? null,
            targetPath: entity.nodeId ?? entity.name,
            lastSyncedAt: entity.lastSyncedAt ?? null,
            syncError: entity.errorMessage ?? null,
            updatedAt: entity.updatedAt,
          },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to persist linked file ${entity.id} to Prisma: ${msg}`,
        );
      }
    }

    // 3. Write-through to Redis cache
    const client = this.getRedisClient();
    if (client) {
      try {
        await client.hset(
          this.projectKey(entity.projectId),
          entity.id,
          JSON.stringify(entity.toJSON()),
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to persist linked file to Redis: ${msg}`);
      }
    }

    return entity;
  }

  public async findById(
    projectId: string,
    id: string,
  ): Promise<LinkedFileEntity | null> {
    // 1. Redis Cache lookup
    const client = this.getRedisClient();
    if (client) {
      try {
        const raw = await client.hget(this.projectKey(projectId), id);
        if (raw) {
          const entity = this.deserialize(raw);
          this.saveToMemoryStore(entity);
          return entity;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Redis read error in findById: ${msg}`);
      }
    }

    // 2. In-memory lookup
    const projectMap = this.memoryStore.get(projectId);
    const cached = projectMap?.get(id);
    if (cached) return cached;

    // 3. Cache-aside Prisma query
    if (this.prisma) {
      try {
        const record = await this.prisma.manuscriptLinkedFile.findFirst({
          where: { projectId, id },
        });
        if (record) {
          const entity = this.mapFromPrisma(record);
          this.saveToMemoryStore(entity);
          if (client) {
            await client
              .hset(
                this.projectKey(projectId),
                id,
                JSON.stringify(entity.toJSON()),
              )
              .catch(() => {});
          }
          return entity;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Prisma findById error for ${id}: ${msg}`);
      }
    }

    return null;
  }

  public async findByProject(projectId: string): Promise<LinkedFileEntity[]> {
    const client = this.getRedisClient();

    // 1. Redis Cache lookup
    if (client) {
      try {
        const all = await client.hgetall(this.projectKey(projectId));
        if (all && Object.keys(all).length > 0) {
          const list: LinkedFileEntity[] = [];
          for (const raw of Object.values(all)) {
            list.push(this.deserialize(raw));
          }
          return list;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Redis read error in findByProject: ${msg}`);
      }
    }

    // 2. Cache-aside Prisma query
    if (this.prisma) {
      try {
        const records = await this.prisma.manuscriptLinkedFile.findMany({
          where: { projectId },
        });
        if (records && records.length > 0) {
          const list = records.map((r) => this.mapFromPrisma(r));
          for (const entity of list) {
            this.saveToMemoryStore(entity);
          }
          if (client) {
            const map: Record<string, string> = {};
            for (const entity of list) {
              map[entity.id] = JSON.stringify(entity.toJSON());
            }
            await client.hset(this.projectKey(projectId), map).catch(() => {});
          }
          return list;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(
          `Prisma findByProject error for ${projectId}: ${msg}`,
        );
      }
    }

    // 3. In-memory fallback
    const projectMap = this.memoryStore.get(projectId);
    return projectMap ? Array.from(projectMap.values()) : [];
  }

  public async findByNodeId(
    projectId: string,
    nodeId: string,
  ): Promise<LinkedFileEntity | null> {
    const all = await this.findByProject(projectId);
    const found = all.find((item) => item.nodeId === nodeId);
    if (found) return found;

    if (this.prisma) {
      try {
        const record = await this.prisma.manuscriptLinkedFile.findFirst({
          where: { projectId, targetPath: nodeId },
        });
        if (record) {
          const entity = this.mapFromPrisma(record);
          this.saveToMemoryStore(entity);
          return entity;
        }
      } catch (err: unknown) {
        this.logger.debug(`Prisma findByNodeId error: ${err}`);
      }
    }

    return null;
  }

  public async findAllAutoRefresh(): Promise<LinkedFileEntity[]> {
    const redisResults = new Map<string, LinkedFileEntity>();
    const client = this.getRedisClient();

    // 1. Scan Redis cache
    if (client) {
      try {
        let cursor = '0';
        do {
          const [nextCursor, keys] = await client.scan(
            cursor,
            'MATCH',
            'manuscript:linked_files:*',
            'COUNT',
            100,
          );
          cursor = nextCursor;
          for (const key of keys) {
            const all = await client.hgetall(key);
            if (all && Object.keys(all).length > 0) {
              for (const raw of Object.values(all)) {
                const entity = this.deserialize(raw);
                if (entity.autoRefresh) {
                  redisResults.set(`${entity.projectId}:${entity.id}`, entity);
                }
              }
            }
          }
        } while (cursor !== '0');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Redis scan error in findAllAutoRefresh: ${msg}`);
      }
    }

    // 2. Query Prisma database
    if (this.prisma) {
      try {
        const records = await this.prisma.manuscriptLinkedFile.findMany({
          where: {
            provider: { in: ['zotero', 'mendeley'] },
          },
        });
        for (const record of records) {
          const entity = this.mapFromPrisma(record);
          const key = `${entity.projectId}:${entity.id}`;
          if (!redisResults.has(key)) {
            redisResults.set(key, entity);
          }
        }
      } catch (err: unknown) {
        this.logger.debug(`Prisma findAllAutoRefresh query notice: ${err}`);
      }
    }

    // 3. Merge in-memory store
    for (const projectMap of this.memoryStore.values()) {
      for (const entity of projectMap.values()) {
        if (entity.autoRefresh) {
          const key = `${entity.projectId}:${entity.id}`;
          if (!redisResults.has(key)) {
            redisResults.set(key, entity);
          }
        }
      }
    }

    return Array.from(redisResults.values());
  }

  public async delete(projectId: string, id: string): Promise<boolean> {
    // 1. Remove from in-memory store
    const projectMap = this.memoryStore.get(projectId);
    if (projectMap) {
      projectMap.delete(id);
      if (projectMap.size === 0) {
        this.memoryStore.delete(projectId);
      }
    }

    // 2. Delete from Redis cache
    const client = this.getRedisClient();
    if (client) {
      try {
        await client.hdel(this.projectKey(projectId), id);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to delete linked file in Redis: ${msg}`);
      }
    }

    // 3. Delete from Prisma DB
    if (this.prisma) {
      try {
        await this.prisma.manuscriptLinkedFile.deleteMany({
          where: { projectId, id },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to delete linked file in Prisma: ${msg}`);
      }
    }

    return true;
  }

  private mapFromPrisma(record: {
    id: string;
    projectId: string;
    name: string;
    provider: string;
    url: string | null;
    targetPath: string;
    targetDocId: string | null;
    targetFileId: string | null;
    lastSyncedAt: Date | null;
    syncError: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): LinkedFileEntity {
    return new LinkedFileEntity({
      id: record.id,
      projectId: record.projectId,
      name: record.name,
      provider: (record.provider as 'url' | 'zotero' | 'mendeley') || 'url',
      url: record.url,
      nodeId: record.targetPath,
      docId: record.targetDocId,
      fileId: record.targetFileId,
      status: record.syncError
        ? 'failed'
        : record.lastSyncedAt
          ? 'synced'
          : 'pending',
      lastSyncedAt: record.lastSyncedAt,
      errorMessage: record.syncError,
      autoRefresh:
        record.provider === 'zotero' || record.provider === 'mendeley',
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  private deserialize(rawJson: string): LinkedFileEntity {
    const data = JSON.parse(rawJson) as LinkedFileJSON;
    const props: LinkedFileProps = {
      id: data.id,
      projectId: data.projectId,
      name: data.name,
      provider: data.provider,
      url: data.url,
      collectionId: data.collectionId,
      nodeId: data.nodeId,
      docId: data.docId,
      fileId: data.fileId,
      status: data.status,
      lastSyncedAt: data.lastSyncedAt ? new Date(data.lastSyncedAt) : null,
      errorMessage: data.errorMessage,
      autoRefresh: data.autoRefresh,
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
    };
    return new LinkedFileEntity(props);
  }
}
