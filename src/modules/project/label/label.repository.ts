import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Label, ProjectLabel } from '@prisma/client';
import {
  CreateProjectLabelDto,
  UpdateProjectLabelDto,
} from './dto/create-label.dto';

@Injectable()
export class LabelRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findLabelsByUser(userId: string): Promise<Label[]> {
    return this.prisma.label.findMany({
      where: { userId },
      orderBy: { name: 'asc' },
    });
  }

  async findLabelById(id: string, userId: string): Promise<Label | null> {
    return this.prisma.label.findFirst({
      where: { id, userId },
    });
  }

  async findLabelByName(name: string, userId: string): Promise<Label | null> {
    return this.prisma.label.findUnique({
      where: {
        userId_name: {
          userId,
          name,
        },
      },
    });
  }

  async createLabel(
    userId: string,
    dto: CreateProjectLabelDto,
  ): Promise<Label> {
    return this.prisma.label.create({
      data: {
        userId,
        name: dto.name.trim(),
        color: dto.color,
        description: dto.description?.trim() || null,
      },
    });
  }

  async updateLabel(id: string, dto: UpdateProjectLabelDto): Promise<Label> {
    return this.prisma.label.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.color !== undefined ? { color: dto.color } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description.trim() || null }
          : {}),
      },
    });
  }

  async deleteLabel(id: string): Promise<Label> {
    return this.prisma.label.delete({
      where: { id },
    });
  }

  async findProjectLabels(
    projectId: string,
  ): Promise<(ProjectLabel & { label: Label })[]> {
    return this.prisma.projectLabel.findMany({
      where: { projectId },
      include: { label: true },
      orderBy: { label: { name: 'asc' } },
    });
  }

  async assignLabelsToProject(
    projectId: string,
    labelIds: string[],
    assignedById?: string,
  ): Promise<void> {
    // Upsert or createMany skipDuplicates
    await this.prisma.projectLabel.createMany({
      data: labelIds.map((labelId) => ({
        projectId,
        labelId,
        ...(assignedById ? { assignedById } : {}),
      })),
      skipDuplicates: true,
    });
  }

  async removeLabelFromProject(
    projectId: string,
    labelId: string,
  ): Promise<void> {
    await this.prisma.projectLabel.deleteMany({
      where: {
        projectId,
        labelId,
      },
    });
  }

  async replaceProjectLabels(
    projectId: string,
    labelIds: string[],
    assignedById?: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.projectLabel.deleteMany({
        where: { projectId },
      });
      if (labelIds.length > 0) {
        await tx.projectLabel.createMany({
          data: labelIds.map((labelId) => ({
            projectId,
            labelId,
            ...(assignedById ? { assignedById } : {}),
          })),
          skipDuplicates: true,
        });
      }
    });
  }
}
