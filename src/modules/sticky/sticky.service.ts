import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Optional,
  Logger,
} from '@nestjs/common';
import { StickyRepository } from './sticky.repository';
import { StickyWithUser } from './types/sticky-repository.interface';
import { CreateStickyDto, UpdateStickyDto } from './dto/sticky.dto';
import { StickyScope } from '@prisma/client';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { STICKY_REDIS_KEYS } from './constants/redis-keys.constant';

@Injectable()
export class StickyService {
  private readonly logger = new Logger(StickyService.name);

  constructor(
    private readonly stickyRepo: StickyRepository,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateStickyCache(
    userId: string,
    workspaceId?: string | null,
    projectId?: string | null,
  ) {
    if (!this.cache) return;
    const promises: Promise<any>[] = [];
    if (workspaceId) {
      promises.push(
        this.cache.del(
          STICKY_REDIS_KEYS.workspaceStickies(workspaceId, userId),
        ),
      );
    }
    if (projectId) {
      promises.push(
        this.cache.del(STICKY_REDIS_KEYS.projectStickies(projectId, userId)),
      );
    }
    await Promise.all(promises).catch((err) => {
      this.logger.warn(`Failed to invalidate sticky cache: ${err}`);
    });
  }

  private formatSticky<T extends { positionX: number; positionY: number }>(
    stickyRecord: T | null | undefined,
  ): (T & { position: { x: number; y: number } }) | null {
    if (!stickyRecord) return null;
    return {
      ...stickyRecord,
      position: { x: stickyRecord.positionX, y: stickyRecord.positionY },
    };
  }

  async getWorkspaceStickies(workspaceId: string, userId: string) {
    const workspace = await this.stickyRepo.resolveWorkspace(workspaceId);
    const resolvedWorkspaceId = workspace?.id || workspaceId;
    const cacheKey = STICKY_REDIS_KEYS.workspaceStickies(
      resolvedWorkspaceId,
      userId,
    );

    if (this.cache) {
      const cached = await this.cache.get<any>(cacheKey);
      if (cached) return cached;
    }

    const stickies = await this.stickyRepo.findWorkspaceStickies(
      resolvedWorkspaceId,
      userId,
    );
    const result = {
      stickies: stickies.map((sticky) => this.formatSticky(sticky)),
    };

    if (this.cache) {
      await this.cache.set(cacheKey, result, 1800);
    }

    return result;
  }

  async getProjectStickies(projectId: string, userId: string) {
    const cacheKey = STICKY_REDIS_KEYS.projectStickies(projectId, userId);

    if (this.cache) {
      const cached = await this.cache.get<any>(cacheKey);
      if (cached) return cached;
    }

    const stickies = await this.stickyRepo.findProjectStickies(
      projectId,
      userId,
    );
    const result = {
      stickies: stickies.map((sticky) => this.formatSticky(sticky)),
    };

    if (this.cache) {
      await this.cache.set(cacheKey, result, 1800);
    }

    return result;
  }

  async createWorkspaceSticky(
    workspaceId: string,
    userId: string,
    dto: CreateStickyDto,
  ) {
    const workspace = await this.stickyRepo.resolveWorkspace(workspaceId);
    const resolvedWorkspaceId = workspace?.id || workspaceId;

    const count = await this.stickyRepo.countWorkspaceStickies(
      resolvedWorkspaceId,
      userId,
    );

    const sticky = await this.stickyRepo.createSticky({
      title: dto.title || '',
      content: dto.content,
      color: dto.color || 'yellow-1',
      scope: StickyScope.workspace,
      positionX: dto.position?.x ?? 0,
      positionY: dto.position?.y ?? 0,
      order: count,
      workspaceId: resolvedWorkspaceId,
      userId,
    });

    await this.invalidateStickyCache(userId, resolvedWorkspaceId);

    return { sticky: this.formatSticky(sticky) };
  }

  async createProjectSticky(
    projectId: string,
    userId: string,
    dto: CreateStickyDto,
  ) {
    let workspaceId = '';
    const resolvedWorkspaceId =
      await this.stickyRepo.findProjectWorkspaceId(projectId);
    if (resolvedWorkspaceId) {
      workspaceId = resolvedWorkspaceId;
    }

    const count = await this.stickyRepo.countProjectStickies(projectId, userId);

    const sticky = await this.stickyRepo.createSticky({
      title: dto.title || '',
      content: dto.content,
      color: dto.color || 'yellow-1',
      scope: StickyScope.project,
      positionX: dto.position?.x ?? 0,
      positionY: dto.position?.y ?? 0,
      order: count,
      workspaceId,
      projectId,
      userId,
    });

    await this.invalidateStickyCache(userId, workspaceId, projectId);

    return { sticky: this.formatSticky(sticky) };
  }

  async updateSticky(stickyId: string, userId: string, dto: UpdateStickyDto) {
    const existingSticky = await this.stickyRepo.findStickyById(stickyId);
    if (!existingSticky) {
      throw new NotFoundException('Sticky note not found');
    }
    if (existingSticky.userId !== userId) {
      throw new ForbiddenException('You can only update your own sticky notes');
    }

    const sticky = await this.stickyRepo.updateSticky(stickyId, {
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.content !== undefined && { content: dto.content }),
      ...(dto.color !== undefined && { color: dto.color }),
      ...(dto.scope !== undefined && { scope: dto.scope }),
      ...(dto.position?.x !== undefined && { positionX: dto.position.x }),
      ...(dto.position?.y !== undefined && { positionY: dto.position.y }),
      ...(dto.projectId !== undefined && { projectId: dto.projectId }),
    });

    await this.invalidateStickyCache(
      userId,
      existingSticky.workspaceId,
      existingSticky.projectId,
    );

    return { sticky: this.formatSticky(sticky) };
  }

  async deleteSticky(stickyId: string, userId: string) {
    const existingSticky = await this.stickyRepo.findStickyById(stickyId);
    if (!existingSticky) {
      throw new NotFoundException('Sticky note not found');
    }
    if (existingSticky.userId !== userId) {
      throw new ForbiddenException('You can only delete your own sticky notes');
    }

    await this.stickyRepo.deleteSticky(stickyId);
    await this.invalidateStickyCache(
      userId,
      existingSticky.workspaceId,
      existingSticky.projectId,
    );

    return { message: 'Sticky deleted successfully', success: true };
  }

  async reorderStickies(stickyIds: string[], userId?: string) {
    if (!stickyIds || stickyIds.length <= 1) {
      return { success: true };
    }
    const stickies = await this.stickyRepo.reorderStickies(stickyIds);

    if (userId && stickies.length > 0) {
      const firstSticky = stickies[0];
      await this.invalidateStickyCache(
        userId,
        firstSticky.workspaceId,
        firstSticky.projectId,
      );
    }

    return { success: true };
  }
}
