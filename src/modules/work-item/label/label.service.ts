import { Injectable, Optional } from '@nestjs/common';
import { LabelRepository } from './label.repository';
import { CreateLabelDto, UpdateLabelDto } from './dto/label.dto';
import { LabelType } from '@prisma/client';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { WORK_ITEM_REDIS_KEYS } from '../constants/redis-keys.constant';
import { PrismaService } from '@/core/database/prisma.service';
import { resolveTenantWorkspaceId } from '@/core/utils/tenant.util';

@Injectable()
export class LabelService {
  constructor(
    private readonly labelRepo: LabelRepository,
    private readonly prisma: PrismaService,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateLabelCache(workspaceId: string) {
    if (!this.cache) return;
    await this.cache.del(WORK_ITEM_REDIS_KEYS.labels(workspaceId));
  }

  async getLabels(workspaceIdOrSlug: string, type?: LabelType) {
    const workspaceId = await resolveTenantWorkspaceId(this.prisma, workspaceIdOrSlug);
    const cacheKey = WORK_ITEM_REDIS_KEYS.labels(workspaceId);

    if (this.cache && !type) {
      const cached = await this.cache.get<any>(cacheKey);
      if (cached) return cached;
    }

    const labels = await this.labelRepo.findWorkspaceLabels(workspaceId, type);
    const result = { labels };

    if (this.cache && !type) {
      await this.cache.set(cacheKey, result, 3600);
    }

    return result;
  }

  async createLabel(workspaceIdOrSlug: string, userId: string, dto: CreateLabelDto) {
    const workspaceId = await resolveTenantWorkspaceId(this.prisma, workspaceIdOrSlug);
    const label = await this.labelRepo.createLabel({
      name: dto.name,
      color: dto.color || '#3b82f6',
      type: dto.type || LabelType.task,
      workspace: { connect: { id: workspaceId } },
      createdBy: { connect: { id: userId } },
    });

    await this.invalidateLabelCache(workspaceId);

    return { label };
  }

  async updateLabel(labelId: string, dto: UpdateLabelDto) {
    const label = await this.labelRepo.updateLabel(labelId, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.color !== undefined && { color: dto.color }),
      ...(dto.type !== undefined && { type: dto.type }),
    });

    await this.invalidateLabelCache(label.workspaceId);

    return { label };
  }

  async deleteLabel(labelId: string) {
    const label = await this.labelRepo.findLabelById(labelId);
    await this.labelRepo.deleteLabel(labelId);
    if (label?.workspaceId) {
      await this.invalidateLabelCache(label.workspaceId);
    }
    return { message: 'Label deleted successfully' };
  }
}
