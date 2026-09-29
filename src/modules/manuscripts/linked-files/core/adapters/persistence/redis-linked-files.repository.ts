/**
 * linked-files/core/adapters/persistence/redis-linked-files.repository.ts
 * Driven adapter implementing ILinkedFilesRepositoryPort via Redis & in-memory cache.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ILinkedFilesRepositoryPort } from '../../ports/linked-files-repository.port';
import {
  LinkedFileEntity,
  LinkedFileProps,
} from '../../domain/entities/linked-file.entity';
import { RedisCacheService } from '@/core/cache/redis.service';

@Injectable()
export class RedisLinkedFilesRepository extends ILinkedFilesRepositoryPort {
  private readonly logger = new Logger(RedisLinkedFilesRepository.name);
  // In-memory fallback: projectId -> Map<id, LinkedFileEntity>
  private readonly memoryStore = new Map<
    string,
    Map<string, LinkedFileEntity>
  >();

  constructor(@Optional() private readonly redis?: RedisCacheService) {
    super();
  }

  private isRedisReady(): boolean {
    return !!(this.redis && this.redis.isReady() && this.redis.getClient());
  }

  private projectKey(projectId: string): string {
    return `manuscript:linked_files:${projectId}`;
  }

  public async save(entity: LinkedFileEntity): Promise<LinkedFileEntity> {
    // 1. Update in-memory
    let projectMap = this.memoryStore.get(entity.projectId);
    if (!projectMap) {
      projectMap = new Map();
      this.memoryStore.set(entity.projectId, projectMap);
    }
    projectMap.set(entity.id, entity);

    // 2. Persist to Redis
    if (this.isRedisReady()) {
      try {
        const client = this.redis!.getClient()!;
        await client.hset(
          this.projectKey(entity.projectId),
          entity.id,
          JSON.stringify(entity.toJSON()),
        );
      } catch (err: any) {
        this.logger.warn(
          `Failed to persist linked file to Redis: ${err?.message}`,
        );
      }
    }

    return entity;
  }

  public async findById(
    projectId: string,
    id: string,
  ): Promise<LinkedFileEntity | null> {
    if (this.isRedisReady()) {
      try {
        const client = this.redis!.getClient()!;
        const raw = await client.hget(this.projectKey(projectId), id);
        if (raw) {
          return this.deserialize(raw);
        }
      } catch (err: any) {
        this.logger.debug(`Redis read error: ${err?.message}`);
      }
    }

    const projectMap = this.memoryStore.get(projectId);
    return projectMap?.get(id) ?? null;
  }

  public async findByProject(projectId: string): Promise<LinkedFileEntity[]> {
    if (this.isRedisReady()) {
      try {
        const client = this.redis!.getClient()!;
        const all = await client.hgetall(this.projectKey(projectId));
        if (all && Object.keys(all).length > 0) {
          const list: LinkedFileEntity[] = [];
          for (const raw of Object.values(all)) {
            list.push(this.deserialize(raw));
          }
          return list;
        }
      } catch (err: any) {
        this.logger.debug(`Redis read error: ${err?.message}`);
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
    projectMap?.delete(id);

    if (this.isRedisReady()) {
      try {
        const client = this.redis!.getClient()!;
        await client.hdel(this.projectKey(projectId), id);
      } catch (err: any) {
        this.logger.warn(
          `Failed to delete linked file in Redis: ${err?.message}`,
        );
      }
    }

    return true;
  }

  private deserialize(rawJson: string): LinkedFileEntity {
    const data = JSON.parse(rawJson);
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
