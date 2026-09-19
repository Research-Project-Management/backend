import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { ProjectTemplate, Prisma } from '@prisma/client';
import { CreateProjectTemplateDto } from './dto/create-template.dto';

@Injectable()
export class TemplateRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAccessibleTemplates(userId: string): Promise<ProjectTemplate[]> {
    return this.prisma.projectTemplate.findMany({
      where: {
        OR: [{ createdById: userId }, { isPublic: true }],
      },
      orderBy: [{ isPublic: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async findTemplateById(id: string): Promise<ProjectTemplate | null> {
    return this.prisma.projectTemplate.findUnique({
      where: { id },
    });
  }

  async createTemplate(
    userId: string,
    dto: CreateProjectTemplateDto,
  ): Promise<ProjectTemplate> {
    return this.prisma.projectTemplate.create({
      data: {
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        avatar: dto.avatar || null,
        coverImage: dto.coverImage || null,
        isPublic: dto.isPublic ?? false,
        createdById: userId,
        defaultModules: dto.defaultModules || [
          'work_items',
          'cycles',
          'views',
          'pages',
          'stickies',
          'storage',
        ],
        initialStates: (dto.initialStates ||
          []) as unknown as Prisma.InputJsonValue,
        initialLabels: (dto.initialLabels ||
          []) as unknown as Prisma.InputJsonValue,
        initialWorkItems: (dto.initialWorkItems ||
          []) as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async updateTemplate(
    id: string,
    data: Partial<CreateProjectTemplateDto>,
  ): Promise<ProjectTemplate> {
    return this.prisma.projectTemplate.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name.trim() } : {}),
        ...(data.description !== undefined
          ? { description: data.description?.trim() || null }
          : {}),
        ...(data.avatar !== undefined ? { avatar: data.avatar } : {}),
        ...(data.coverImage !== undefined
          ? { coverImage: data.coverImage }
          : {}),
        ...(data.isPublic !== undefined ? { isPublic: data.isPublic } : {}),
        ...(data.defaultModules !== undefined
          ? { defaultModules: data.defaultModules }
          : {}),
        ...(data.initialStates !== undefined
          ? {
              initialStates:
                data.initialStates as unknown as Prisma.InputJsonValue,
            }
          : {}),
        ...(data.initialLabels !== undefined
          ? {
              initialLabels:
                data.initialLabels as unknown as Prisma.InputJsonValue,
            }
          : {}),
        ...(data.initialWorkItems !== undefined
          ? {
              initialWorkItems:
                data.initialWorkItems as unknown as Prisma.InputJsonValue,
            }
          : {}),
      },
    });
  }

  async deleteTemplate(id: string): Promise<ProjectTemplate> {
    return this.prisma.projectTemplate.delete({
      where: { id },
    });
  }
}
