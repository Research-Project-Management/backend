import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RedisCacheService } from './redis-cache.service';

export interface EntityChangeEvent {
  entityType?: string;
  entityId?: string;
  verb?: string;
  workspaceId?: string;
  projectId?: string;
}

@Injectable()
export class CacheInvalidationListener {
  private readonly logger = new Logger(CacheInvalidationListener.name);

  constructor(private readonly redisCache: RedisCacheService) {}

  @OnEvent('cache.invalidate', { async: true })
  async handleManualInvalidation(payload: {
    pattern?: string;
    key?: string;
    workspaceId?: string;
    projectId?: string;
  }) {
    if (payload.key) {
      await this.redisCache.del(payload.key);
    }
    if (payload.pattern) {
      await this.redisCache.delPattern(payload.pattern);
    }
    if (payload.workspaceId) {
      await this.redisCache.invalidateWorkspace(payload.workspaceId);
    }
    if (payload.projectId) {
      await this.redisCache.invalidateProject(payload.projectId);
    }
  }

  @OnEvent('task.*', { async: true })
  async handleTaskChanged(event: EntityChangeEvent) {
    if (event.projectId) {
      await this.redisCache.delPattern(`tasks:${event.projectId}:*`);
      await this.redisCache.delPattern(
        `analytics:project:${event.projectId}:*`,
      );
    }
    if (event.workspaceId) {
      await this.redisCache.delPattern(
        `analytics:workspace:${event.workspaceId}:*`,
      );
    }
    if (event.entityId) {
      await this.redisCache.del(`task:${event.entityId}`);
    }
  }

  @OnEvent('paper.*', { async: true })
  async handlePaperChanged(event: EntityChangeEvent) {
    if (event.workspaceId) {
      await this.redisCache.delPattern(`papers:${event.workspaceId}:*`);
      await this.redisCache.delPattern(`library:${event.workspaceId}:*`);
    }
    if (event.entityId) {
      await this.redisCache.del(`paper:${event.entityId}`);
      await this.redisCache.del(`paper:bundle:${event.entityId}`);
    }
  }

  @OnEvent('page.*', { async: true })
  async handlePageChanged(event: EntityChangeEvent) {
    if (event.projectId) {
      await this.redisCache.delPattern(`pages:${event.projectId}:*`);
    }
    if (event.entityId) {
      await this.redisCache.del(`page:${event.entityId}`);
    }
  }

  @OnEvent('file.*', { async: true })
  async handleFileChanged(event: EntityChangeEvent) {
    if (event.workspaceId) {
      await this.redisCache.delPattern(`files:${event.workspaceId}:*`);
      await this.redisCache.delPattern(`storage:${event.workspaceId}:*`);
    }
  }

  @OnEvent('sticky.*', { async: true })
  async handleStickyChanged(event: EntityChangeEvent) {
    if (event.workspaceId) {
      await this.redisCache.delPattern(`stickies:${event.workspaceId}:*`);
    }
    if (event.projectId) {
      await this.redisCache.delPattern(`stickies:project:${event.projectId}:*`);
    }
  }

  @OnEvent('project.*', { async: true })
  async handleProjectChanged(event: EntityChangeEvent) {
    if (event.workspaceId) {
      await this.redisCache.delPattern(`projects:${event.workspaceId}:*`);
      await this.redisCache.delPattern(
        `analytics:workspace:${event.workspaceId}:*`,
      );
    }
    if (event.entityId || event.projectId) {
      const pid = event.entityId || event.projectId;
      await this.redisCache.del(`project:${pid}`);
      await this.redisCache.delPattern(`tasks:${pid}:*`);
      await this.redisCache.delPattern(`analytics:project:${pid}:*`);
    }
  }

  @OnEvent('cycle.*', { async: true })
  async handleCycleChanged(event: EntityChangeEvent) {
    if (event.projectId) {
      await this.redisCache.delPattern(`cycles:${event.projectId}:*`);
      await this.redisCache.delPattern(`tasks:${event.projectId}:*`);
      await this.redisCache.delPattern(
        `analytics:project:${event.projectId}:*`,
      );
    }
    if (event.entityId) {
      await this.redisCache.del(`cycle:${event.entityId}`);
    }
  }
}
