import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  UnprocessableEntityException,
  Optional,
  Logger,
} from '@nestjs/common';
import { StickyRepository } from './sticky.repository';
import { CreateStickyDto, UpdateStickyDto } from './dto/sticky.dto';
import { RedisCacheService } from '@/core/cache/redis.service';
import { STICKY_REDIS_KEYS } from './constants/redis-keys.constant';
import { PrismaService } from '@/core/database/prisma.service';
import {
  getNextStickyColor,
  isStickyContentEmpty,
  normalizeStickyColor,
  sanitizeStickyHtml,
  uuidv7,
} from './utils/sticky.utils';

@Injectable()
export class StickyService {
  private readonly logger = new Logger(StickyService.name);

  constructor(
    private readonly stickyRepo: StickyRepository,
    private readonly prisma: PrismaService,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateStickyCache(userId: string) {
    if (!this.cache) return;
    try {
      await this.cache.del(STICKY_REDIS_KEYS.userStickies(userId));
    } catch (err) {
      this.logger.warn(`Failed to invalidate sticky cache: ${String(err)}`);
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

  async getStickies(userId: string, search?: string) {
    if (search && search.trim()) {
      const stickies = await this.stickyRepo.findStickiesByUserId(
        userId,
        search,
      );
      return {
        stickies: stickies.map((sticky) => this.formatSticky(sticky)),
      };
    }

    const cacheKey = STICKY_REDIS_KEYS.userStickies(userId);
    return this.getStickiesWithCache(cacheKey, async () => {
      return this.stickyRepo.findStickiesByUserId(userId);
    });
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

  async getStickyById(stickyId: string, userId: string) {
    const existingSticky = await this.stickyRepo.findStickyById(stickyId);
    if (!existingSticky) {
      throw new NotFoundException('Sticky not found');
    }

    if (existingSticky.userId !== userId) {
      throw new ForbiddenException('You can only access your own sticky notes');
    }

    return { sticky: this.formatSticky(existingSticky) };
  }

  async createSticky(userId: string, dto: CreateStickyDto) {
    const order = await this.stickyRepo.countStickiesByUserId(userId);

    // 1. Authoritative Server Check: Find the latest note
    const latestSticky = await this.prisma.sticky.findFirst({
      where: {
        userId,
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, content: true, color: true },
    });

    // 2. Reject creating a new note if the latest one is still blank
    if (
      latestSticky &&
      isStickyContentEmpty(latestSticky.title, latestSticky.content)
    ) {
      throw new UnprocessableEntityException(
        'Please add content to your existing draft note before creating a new one',
      );
    }

    // 3. Authoritative Color Rotation: If client didn't supply color, auto-rotate based on latest note
    const resolvedColor = dto.color
      ? normalizeStickyColor(dto.color)
      : getNextStickyColor(latestSticky?.color);

    // 4. Server-side HTML Sanitization against Stored XSS
    const sanitizedContent = sanitizeStickyHtml(dto.content || '<p></p>');

    const sticky = await this.stickyRepo.createSticky({
      id: dto.id ?? uuidv7(),
      title: dto.title ? dto.title.trim() : '',
      content: sanitizedContent,
      color: resolvedColor,
      positionX: dto.position?.x ?? 0,
      positionY: dto.position?.y ?? 0,
      order,
      userId,
    });

    await this.invalidateStickyCache(userId);

    return { sticky: this.formatSticky(sticky) };
  }

  async updateSticky(stickyId: string, userId: string, dto: UpdateStickyDto) {
    const existingSticky = await this.stickyRepo.findStickyById(stickyId);
    if (!existingSticky) {
      throw new NotFoundException('Sticky not found');
    }

    if (existingSticky.userId !== userId) {
      throw new ForbiddenException('You can only update your own sticky notes');
    }

    const updateData: any = {};
    if (dto.title !== undefined) updateData.title = dto.title.trim();
    if (dto.content !== undefined) {
      updateData.content = sanitizeStickyHtml(dto.content);
    }
    if (dto.color !== undefined) {
      updateData.color = normalizeStickyColor(dto.color);
    }
    if (dto.position) {
      updateData.positionX = dto.position.x;
      updateData.positionY = dto.position.y;
    }

    const updated = await this.stickyRepo.updateSticky(stickyId, updateData);

    await this.invalidateStickyCache(userId);

    return { sticky: this.formatSticky(updated) };
  }

  async deleteSticky(stickyId: string, userId: string) {
    const existingSticky = await this.stickyRepo.findStickyById(stickyId);
    if (!existingSticky) {
      throw new NotFoundException('Sticky not found');
    }

    if (existingSticky.userId !== userId) {
      throw new ForbiddenException('You can only delete your own sticky notes');
    }

    await this.stickyRepo.deleteSticky(stickyId);

    await this.invalidateStickyCache(userId);

    return { success: true, message: 'Sticky deleted successfully' };
  }

  async reorderStickies(stickyIds: string[], userId: string) {
    if (!stickyIds || stickyIds.length === 0) {
      return { success: true, count: 0 };
    }

    const stickies = await this.stickyRepo.findStickiesByIds(stickyIds);

    for (const sticky of stickies) {
      if (sticky.userId !== userId) {
        throw new ForbiddenException(
          'You can only reorder your own sticky notes',
        );
      }
    }

    const reordered = await this.stickyRepo.reorderStickies(stickyIds);

    await this.invalidateStickyCache(userId);

    return {
      success: true,
      count: reordered.length,
      stickies: reordered.map((s) => this.formatSticky(s)),
    };
  }
}
