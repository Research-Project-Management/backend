import { Injectable } from '@nestjs/common';
import { LabelRepository } from './label.repository';
import { CreateLabelDto, UpdateLabelDto } from './dto/label.dto';
import { LabelType } from '@prisma/client';

@Injectable()
export class LabelService {
  constructor(private readonly labelRepo: LabelRepository) {}

  async getLabels(workspaceId: string, type?: LabelType) {
    const labels = await this.labelRepo.findWorkspaceLabels(workspaceId, type);
    return { labels };
  }

  async createLabel(workspaceId: string, userId: string, dto: CreateLabelDto) {
    const label = await this.labelRepo.createLabel({
      name: dto.name,
      color: dto.color || '#3b82f6',
      type: dto.type || LabelType.sticky,
      workspaceId,
      createdById: userId,
    });

    return { label };
  }

  async updateLabel(labelId: string, dto: UpdateLabelDto) {
    const label = await this.labelRepo.updateLabel(labelId, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.color !== undefined && { color: dto.color }),
      ...(dto.type !== undefined && { type: dto.type }),
    });

    return { label };
  }

  async deleteLabel(labelId: string) {
    await this.labelRepo.deleteLabel(labelId);
    return { message: 'Label deleted successfully' };
  }
}
