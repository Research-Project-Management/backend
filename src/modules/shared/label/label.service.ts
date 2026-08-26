import { Injectable, Optional } from '@nestjs/common';
import { LabelRepository } from './label.repository';
import { CreateLabelDto, UpdateLabelDto } from './dto/label.dto';
import { LabelType } from '@prisma/client';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { STORAGE_REDIS_KEYS } from '@/modules/storage/file/constants/redis-keys.constant';

@Injectable()
export class LabelService {
  constructor(
    private readonly labelRepo: LabelRepository,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateLabelCache(workspaceId: string) {
    if (!this.cache) return;
    await this.cache.del(STORAGE_REDIS_KEYS.labels(workspaceId));
  }

  async getLabels(workspaceId: string, type?: LabelType) {
    const cacheKey = STORAGE_REDIS_KEYS.labels(workspaceId);

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

  async createLabel(workspaceId: string, userId: string, dto: CreateLabelDto) {
    const label = await this.labelRepo.createLabel({
      name: dto.name,
      color: dto.color || '#3b82f6',
      type: dto.type || LabelType.sticky,
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
