import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { ProjectLabel, ProjectLabelAssignment } from '@prisma/client';
import { CreateProjectLabelDto, UpdateProjectLabelDto } from './dto/create-label.dto';

@Injectable()
export class LabelRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findLabelsByUser(userId: string): Promise<ProjectLabel[]> {
    return this.prisma.projectLabel.findMany({
      where: { userId },
      orderBy: { name: 'asc' },
    });
  }

  async findLabelById(id: string, userId: string): Promise<ProjectLabel | null> {
    return this.prisma.projectLabel.findFirst({
      where: { id, userId },
    });
  }

  async findLabelByName(name: string, userId: string): Promise<ProjectLabel | null> {
    return this.prisma.projectLabel.findUnique({
      where: {
        userId_name: {
          userId,
          name,
        },
      },
    });
  }

  async createLabel(userId: string, dto: CreateProjectLabelDto): Promise<ProjectLabel> {
    return this.prisma.projectLabel.create({
      data: {
        userId,
        name: dto.name.trim(),
        color: dto.color,
        description: dto.description?.trim() || null,
      },
    });
  }

  async updateLabel(
    id: string,
    dto: UpdateProjectLabelDto,
  ): Promise<ProjectLabel> {
    return this.prisma.projectLabel.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.color !== undefined ? { color: dto.color } : {}),
        ...(dto.description !== undefined ? { description: dto.description.trim() || null } : {}),
      },
    });
  }

  async deleteLabel(id: string): Promise<ProjectLabel> {
    return this.prisma.projectLabel.delete({
      where: { id },
    });
  }

  async findProjectLabels(projectId: string): Promise<(ProjectLabelAssignment & { label: ProjectLabel })[]> {
    return this.prisma.projectLabelAssignment.findMany({
      where: { projectId },
      include: { label: true },
      orderBy: { label: { name: 'asc' } },
    });
  }

  async assignLabelsToProject(
    projectId: string,
    labelIds: string[],
  ): Promise<void> {
    // Upsert or createMany skipDuplicates
    await this.prisma.projectLabelAssignment.createMany({
      data: labelIds.map((labelId) => ({
        projectId,
        labelId,
      })),
      skipDuplicates: true,
    });
  }

  async removeLabelFromProject(projectId: string, labelId: string): Promise<void> {
    await this.prisma.projectLabelAssignment.deleteMany({
      where: {
        projectId,
        labelId,
      },
    });
  }

  async replaceProjectLabels(projectId: string, labelIds: string[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.projectLabelAssignment.deleteMany({
        where: { projectId },
      });
      if (labelIds.length > 0) {
        await tx.projectLabelAssignment.createMany({
          data: labelIds.map((labelId) => ({
            projectId,
            labelId,
          })),
          skipDuplicates: true,
        });
      }
    });
  }
}
