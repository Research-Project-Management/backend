import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { SpaceLabel, ProjectLabel } from '@prisma/client';
import {
  CreateProjectLabelDto,
  UpdateProjectLabelDto,
} from './dto/create-label.dto';

export type Label = SpaceLabel;

@Injectable()
export class LabelRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findLabelsByUser(userId: string): Promise<SpaceLabel[]> {
    return this.prisma.spaceLabel.findMany({
      where: { spaceId: userId },
      orderBy: { name: 'asc' },
    });
  }

  async findLabelById(id: string, userId: string): Promise<SpaceLabel | null> {
    return this.prisma.spaceLabel.findFirst({
      where: { id, spaceId: userId },
    });
  }

  async findLabelByName(
    name: string,
    userId: string,
  ): Promise<SpaceLabel | null> {
    return this.prisma.spaceLabel.findFirst({
      where: {
        spaceId: userId,
        name,
      },
    });
  }

  async createLabel(
    userId: string,
    dto: CreateProjectLabelDto,
  ): Promise<SpaceLabel> {
    return this.prisma.spaceLabel.create({
      data: {
        spaceId: userId,
        createdById: userId,
        name: dto.name.trim(),
        color: dto.color,
        description: dto.description?.trim() || null,
      },
    });
  }

  async updateLabel(
    id: string,
    dto: UpdateProjectLabelDto,
  ): Promise<SpaceLabel> {
    return this.prisma.spaceLabel.update({
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

  async deleteLabel(id: string): Promise<SpaceLabel> {
    return this.prisma.spaceLabel.delete({
      where: { id },
    });
  }

  async findProjectLabels(
    projectId: string,
  ): Promise<(ProjectLabel & { label: SpaceLabel })[]> {
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
    if (!labelIds.length) return;
    const validLabels = await this.prisma.spaceLabel.findMany({
      where: { id: { in: labelIds } },
      select: { id: true },
    });
    const validIds = validLabels.map((l) => l.id);
    if (!validIds.length) return;

    await this.prisma.projectLabel.createMany({
      data: validIds.map((labelId) => ({
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
        const validLabels = await tx.spaceLabel.findMany({
          where: { id: { in: labelIds } },
          select: { id: true },
        });
        const validIds = validLabels.map((l) => l.id);
        if (validIds.length > 0) {
          await tx.projectLabel.createMany({
            data: validIds.map((labelId) => ({
              projectId,
              labelId,
              ...(assignedById ? { assignedById } : {}),
            })),
            skipDuplicates: true,
          });
        }
      }
    });
  }
}
