import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Optional,
  Logger,
} from '@nestjs/common';
import { StickyRepository } from './sticky.repository';
import { CreateStickyDto, UpdateStickyDto } from './dto/sticky.dto';
import { RedisCacheService } from '@/core/cache/redis.service';
import { STICKY_REDIS_KEYS } from './constants/redis-keys.constant';
import { PrismaService } from '@/core/database/prisma.service';

@Injectable()
export class StickyService {
  private readonly logger = new Logger(StickyService.name);

  constructor(
    private readonly stickyRepo: StickyRepository,
    private readonly prisma: PrismaService,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateStickyCache(
    userId: string,
    projectId?: string | null,
  ) {
    if (!this.cache) return;
    try {
      const promises: Promise<any>[] = [
        this.cache.del(STICKY_REDIS_KEYS.userStickies(userId)),
      ];
      if (projectId) {
        promises.push(
          this.cache.del(STICKY_REDIS_KEYS.projectStickies(projectId)),
        );
      }
      await Promise.all(promises);
    } catch (err) {
      this.logger.warn(`Failed to invalidate sticky cache: ${err}`);
    }
  }

  private async validateProjectAccess(
    userId: string,
    projectId: string,
  ): Promise<void> {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        deletedAt: null,
        OR: [
          { createdById: userId },
          { members: { some: { userId } } },
        ],
      },
      select: { id: true },
    });
    if (!project) {
      throw new ForbiddenException('You do not have access to this project');
    }
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

  async getStickies(userId: string, projectId?: string) {
    if (projectId) {
      await this.validateProjectAccess(userId, projectId);
      const cacheKey = STICKY_REDIS_KEYS.projectStickies(projectId);
      return this.getStickiesWithCache(cacheKey, async () => {
        return this.stickyRepo.findStickiesByProjectId(projectId);
      });
    }

    const cacheKey = STICKY_REDIS_KEYS.userStickies(userId);
    return this.getStickiesWithCache(cacheKey, async () => {
      return this.stickyRepo.findStickiesByUserId(userId);
    });
  }

  async getPersonalStickies(userId: string) {
    return this.getStickies(userId);
  }

  private async getStickiesWithCache(
    cacheKey: string,
    fetcher: () => Promise<any[]>,
  ) {
    if (this.cache) {
      const cached = await this.cache.get<any>(cacheKey);
      if (cached) return cached;
    }

    const stickies = await fetcher();
    const result = {
      stickies: stickies.map((sticky) => this.formatSticky(sticky)),
    };

    if (this.cache) {
      await this.cache.set(cacheKey, result, 1800);
    }

    return result;
  }

  async createSticky(userId: string, dto: CreateStickyDto) {
    let order: number;
    let scope: 'personal' | 'project' = 'personal';

    if (dto.projectId) {
      await this.validateProjectAccess(userId, dto.projectId);
      scope = 'project';
      order = await this.stickyRepo.countStickiesByProjectId(dto.projectId);
    } else {
      order = await this.stickyRepo.countStickiesByUserId(userId);
    }

    const sticky = await this.stickyRepo.createSticky({
      title: dto.title || '',
      content: dto.content,
      color: dto.color || 'yellow-1',
      scope,
      positionX: dto.position?.x ?? 0,
      positionY: dto.position?.y ?? 0,
      order,
      userId,
      projectId: dto.projectId,
    });

    await this.invalidateStickyCache(userId, dto.projectId);

    return { sticky: this.formatSticky(sticky) };
  }

  async createPersonalSticky(userId: string, dto: CreateStickyDto) {
    return this.createSticky(userId, dto);
  }

  async updateSticky(stickyId: string, userId: string, dto: UpdateStickyDto) {
    const existingSticky = await this.stickyRepo.findStickyById(stickyId);
    if (!existingSticky) {
      throw new NotFoundException('Sticky not found');
    }

    if (existingSticky.projectId) {
      await this.validateProjectAccess(userId, existingSticky.projectId);
    } else if (existingSticky.userId !== userId) {
      throw new ForbiddenException(
        'You can only update your own sticky notes',
      );
    }

    const updateData: any = {};
    if (dto.title !== undefined) updateData.title = dto.title;
    if (dto.content !== undefined) updateData.content = dto.content;
    if (dto.color !== undefined) updateData.color = dto.color;
    if (dto.position) {
      updateData.positionX = dto.position.x;
      updateData.positionY = dto.position.y;
    }

    const updated = await this.stickyRepo.updateSticky(stickyId, updateData);

    await this.invalidateStickyCache(
      existingSticky.userId,
      existingSticky.projectId,
    );

    return { sticky: this.formatSticky(updated) };
  }

  async deleteSticky(stickyId: string, userId: string) {
    const existingSticky = await this.stickyRepo.findStickyById(stickyId);
    if (!existingSticky) {
      throw new NotFoundException('Sticky not found');
    }

    if (existingSticky.projectId) {
      await this.validateProjectAccess(userId, existingSticky.projectId);
    } else if (existingSticky.userId !== userId) {
      throw new ForbiddenException(
        'You can only delete your own sticky notes',
      );
    }

    await this.stickyRepo.deleteSticky(stickyId);

    await this.invalidateStickyCache(
      existingSticky.userId,
      existingSticky.projectId,
    );

    return { success: true, message: 'Sticky deleted successfully' };
  }

  async reorderStickies(
    stickyIds: string[],
    userId: string,
    projectId?: string,
  ) {
    if (!stickyIds || stickyIds.length === 0) {
      return { success: true, count: 0 };
    }

    if (projectId) {
      await this.validateProjectAccess(userId, projectId);
    }

    const stickies = await this.stickyRepo.findStickiesByIds(stickyIds);

    for (const sticky of stickies) {
      if (sticky.projectId) {
        if (sticky.projectId !== projectId) {
          await this.validateProjectAccess(userId, sticky.projectId);
        }
      } else if (sticky.userId !== userId) {
        throw new ForbiddenException(
          'You can only reorder your own sticky notes',
        );
      }
    }

    const reordered = await this.stickyRepo.reorderStickies(stickyIds);

    await this.invalidateStickyCache(userId, projectId);

    return {
      success: true,
      count: reordered.length,
      stickies: reordered.map((s) => this.formatSticky(s)),
    };
  }
}
