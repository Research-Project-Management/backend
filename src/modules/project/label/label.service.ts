import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { SpaceLabel } from '@prisma/client';
import { LabelRepository } from './label.repository';
import {
  CreateProjectLabelDto,
  UpdateProjectLabelDto,
} from './dto/create-label.dto';

@Injectable()
export class LabelService {
  constructor(private readonly labelRepo: LabelRepository) {}

  async getUserLabels(userId: string): Promise<SpaceLabel[]> {
    return this.labelRepo.findLabelsByUser(userId);
  }

  async createLabel(
    userId: string,
    dto: CreateProjectLabelDto,
  ): Promise<SpaceLabel> {
    const existing = await this.labelRepo.findLabelByName(
      dto.name.trim(),
      userId,
    );
    if (existing) {
      throw new ConflictException(`Project label "${dto.name}" already exists`);
    }
    return this.labelRepo.createLabel(userId, dto);
  }

  async updateLabel(
    id: string,
    userId: string,
    dto: UpdateProjectLabelDto,
  ): Promise<SpaceLabel> {
    const label = await this.labelRepo.findLabelById(id, userId);
    if (!label) {
      throw new NotFoundException(`Project label with ID "${id}" not found`);
    }

    if (dto.name && dto.name.trim() !== label.name) {
      const existing = await this.labelRepo.findLabelByName(
        dto.name.trim(),
        userId,
      );
      if (existing && existing.id !== id) {
        throw new ConflictException(
          `Project label "${dto.name}" already exists`,
        );
      }
    }

    return this.labelRepo.updateLabel(id, dto);
  }

  async deleteLabel(id: string, userId: string): Promise<{ message: string }> {
    const label = await this.labelRepo.findLabelById(id, userId);
    if (!label) {
      throw new NotFoundException(`Project label with ID "${id}" not found`);
    }
    await this.labelRepo.deleteLabel(id);
    return { message: 'Project label deleted successfully' };
  }

  async getProjectLabels(projectId: string): Promise<SpaceLabel[]> {
    const assignments = await this.labelRepo.findProjectLabels(projectId);
    return assignments.map((a) => a.label);
  }

  async assignLabelsToProject(
    projectId: string,
    labelIds: string[],
    assignedById?: string,
  ): Promise<SpaceLabel[]> {
    await this.labelRepo.assignLabelsToProject(
      projectId,
      labelIds,
      assignedById,
    );
    return this.getProjectLabels(projectId);
  }

  async removeLabelFromProject(
    projectId: string,
    labelId: string,
  ): Promise<SpaceLabel[]> {
    await this.labelRepo.removeLabelFromProject(projectId, labelId);
    return this.getProjectLabels(projectId);
  }

  async replaceProjectLabels(
    projectId: string,
    labelIds: string[],
    assignedById?: string,
  ): Promise<SpaceLabel[]> {
    await this.labelRepo.replaceProjectLabels(
      projectId,
      labelIds,
      assignedById,
    );
    return this.getProjectLabels(projectId);
  }
}
