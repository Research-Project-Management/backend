/**
 * linked-files/linked-files.repository.ts
 * Direct @Injectable() Repository for Manuscripts Linked Files.
 *
 * Encapsulates the real seam between Redis hash storage and the in-memory Map fallback.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
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

  constructor(@Optional() private readonly redis?: RedisCacheService) {
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
    const client = this.getRedisClient();
    if (client) {
      try {
        await client.hset(
          this.projectKey(entity.projectId),
          entity.id,
          JSON.stringify(entity.toJSON()),
        );
        return entity;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to persist linked file to Redis: ${msg}`);
      }
    }

    this.saveToMemoryStore(entity);
    return entity;
  }

  public async findById(
    projectId: string,
    id: string,
  ): Promise<LinkedFileEntity | null> {
    const client = this.getRedisClient();
    if (client) {
      try {
        const raw = await client.hget(this.projectKey(projectId), id);
        if (raw) {
          return this.deserialize(raw);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Redis read error: ${msg}`);
      }
    }

    const projectMap = this.memoryStore.get(projectId);
    return projectMap?.get(id) ?? null;
  }

  public async findByProject(projectId: string): Promise<LinkedFileEntity[]> {
    const client = this.getRedisClient();
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
        this.logger.debug(`Redis read error: ${msg}`);
      }
    }

    const projectMap = this.memoryStore.get(projectId);
    return projectMap ? Array.from(projectMap.values()) : [];
  }

  public async findByNodeId(
    projectId: string,
    nodeId: string,
  ): Promise<LinkedFileEntity | null> {
    const all = await this.findByProject(projectId);
    return all.find((item) => item.nodeId === nodeId) ?? null;
  }

  public async findAllAutoRefresh(): Promise<LinkedFileEntity[]> {
    const client = this.getRedisClient();
    if (client) {
      try {
        const redisResults = new Map<string, LinkedFileEntity>();
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Redis scan error in findAllAutoRefresh: ${msg}`);
      }
    }

    const results: LinkedFileEntity[] = [];
    for (const projectMap of this.memoryStore.values()) {
      for (const entity of projectMap.values()) {
        if (entity.autoRefresh) {
          results.push(entity);
        }
      }
    }
    return results;
  }

  public async delete(projectId: string, id: string): Promise<boolean> {
    const projectMap = this.memoryStore.get(projectId);
    if (projectMap) {
      projectMap.delete(id);
      if (projectMap.size === 0) {
        this.memoryStore.delete(projectId);
      }
    }

    const client = this.getRedisClient();
    if (client) {
      try {
        await client.hdel(this.projectKey(projectId), id);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to delete linked file in Redis: ${msg}`);
      }
    }

    return true;
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
