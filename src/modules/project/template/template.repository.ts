import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { ProjectTemplate, Prisma, Project, WorkItemPriority } from '@prisma/client';
import {
  CreateProjectTemplateDto,
  InitialStateDto,
  InitialLabelDto,
  InitialWorkItemDto,
} from './dto/create-template.dto';
import { InstantiateProjectTemplateDto } from './dto/instantiate-template.dto';
import { DEFAULT_WORK_ITEM_STATES } from '@/modules/work-item';

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
          'overview',
          'work_items',
          'pages',
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

  async instantiateProject(
    template: ProjectTemplate,
    userId: string,
    identifier: string,
    dto: InstantiateProjectTemplateDto,
  ): Promise<Project> {
    return this.prisma.$transaction(async (tx) => {
      // 1. Create the project
      const project = await tx.project.create({
        data: {
          name: dto.name.trim(),
          identifier,
          description: dto.description?.trim() || template.description || '',
          avatar: template.avatar || '📁',
          coverImage: template.coverImage || null,
          createdById: userId,
          templateId: template.id,
          modules: template.defaultModules || [
            'work_items',
            'cycles',
            'views',
            'pages',
          ],
          members: {
            create: {
              userId,
              role: 'owner',
            },
          },
        },
      });

      // 2. Seed initial workflow states
      const rawStates =
        (template.initialStates as unknown as InitialStateDto[]) || [];
      const statesToSeed =
        rawStates.length > 0 ? rawStates : DEFAULT_WORK_ITEM_STATES;

      const createdStates = await Promise.all(
        statesToSeed.map((st, idx) =>
          tx.workItemState.create({
            data: {
              projectId: project.id,
              name: st.name,
              group: st.group,
              color: st.color || '#6B7280',
              sequence: (idx + 1) * 10,
            },
          }),
        ),
      );

      const defaultState =
        createdStates.find((s) => s.group === 'unstarted') || createdStates[0];

      // 3. Seed initial labels
      const rawLabels =
        (template.initialLabels as unknown as InitialLabelDto[]) || [];
      for (const lbl of rawLabels) {
        await tx.workItemLabel.create({
          data: {
            projectId: project.id,
            name: lbl.name,
            color: lbl.color,
            createdById: userId,
          },
        });
      }

      // 4. Seed initial work items
      const rawWorkItems =
        (template.initialWorkItems as unknown as InitialWorkItemDto[]) || [];
      let sequence = 0;

      for (const wi of rawWorkItems) {
        sequence++;
        await tx.workItem.create({
          data: {
            projectId: project.id,
            title: wi.title,
            content: wi.description || '',
            priority:
              wi.priority &&
              Object.values(WorkItemPriority).includes(
                wi.priority as WorkItemPriority,
              )
                ? (wi.priority as WorkItemPriority)
                : WorkItemPriority.medium,
            columnId: defaultState?.id || '',
            sequenceNumber: sequence,
            authorId: userId,
          },
        });
      }

      // Update sequence on project
      if (sequence > 0) {
        await tx.project.update({
          where: { id: project.id },
          data: { workItemSequence: sequence },
        });
      }

      return project;
    });
  }
}
