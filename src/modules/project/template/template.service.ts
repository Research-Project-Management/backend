import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { ProjectTemplate } from '@prisma/client';
import { TemplateRepository } from './template.repository';
import { CreateProjectTemplateDto, InitialStateDto, InitialLabelDto, InitialWorkItemDto } from './dto/create-template.dto';
import { InstantiateProjectTemplateDto } from './dto/instantiate-template.dto';
import { deriveProjectPrefix } from '../core/utils/identifier.util';
import { DEFAULT_WORK_ITEM_STATES } from '@/modules/work-item/state/types/state.types';

@Injectable()
export class TemplateService {
  constructor(
    private readonly templateRepo: TemplateRepository,
    private readonly prisma: PrismaService,
  ) {}

  async listTemplates(userId: string): Promise<ProjectTemplate[]> {
    return this.templateRepo.findAccessibleTemplates(userId);
  }

  async getTemplateById(id: string): Promise<ProjectTemplate> {
    const template = await this.templateRepo.findTemplateById(id);
    if (!template) {
      throw new NotFoundException(`Project template with ID "${id}" not found`);
    }
    return template;
  }

  async createTemplate(
    userId: string,
    dto: CreateProjectTemplateDto,
  ): Promise<ProjectTemplate> {
    return this.templateRepo.createTemplate(userId, dto);
  }

  async updateTemplate(
    id: string,
    userId: string,
    dto: Partial<CreateProjectTemplateDto>,
  ): Promise<ProjectTemplate> {
    const template = await this.getTemplateById(id);
    if (template.createdById !== userId) {
      throw new ForbiddenException('Only the template creator can modify this template');
    }
    return this.templateRepo.updateTemplate(id, dto);
  }

  async deleteTemplate(id: string, userId: string): Promise<{ message: string }> {
    const template = await this.getTemplateById(id);
    if (template.createdById !== userId) {
      throw new ForbiddenException('Only the template creator can delete this template');
    }
    await this.templateRepo.deleteTemplate(id);
    return { message: 'Project template deleted successfully' };
  }

  /**
   * Instantiate a new project from a Project Template.
   * Atomically sets up Project, Owner membership, initial states, labels, and initial work items.
   */
  async instantiate(
    templateId: string,
    userId: string,
    dto: InstantiateProjectTemplateDto,
  ) {
    const template = await this.getTemplateById(templateId);

    const identifier = deriveProjectPrefix(dto.identifier, dto.name);

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
          modules: (template.defaultModules as string[]) || [
            'work_items',
            'cycles',
            'views',
            'pages',
            'stickies',
            'storage',
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
      const rawStates = (template.initialStates as unknown as InitialStateDto[]) || [];
      const statesToSeed = rawStates.length > 0 ? rawStates : DEFAULT_WORK_ITEM_STATES;

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

      const defaultState = createdStates.find((s) => s.group === 'unstarted') || createdStates[0];

      // 3. Seed initial labels
      const rawLabels = (template.initialLabels as unknown as InitialLabelDto[]) || [];
      const labelMap = new Map<string, string>();

      for (const lbl of rawLabels) {
        const created = await tx.label.create({
          data: {
            projectId: project.id,
            name: lbl.name,
            color: lbl.color,
            createdById: userId,
          },
        });
        labelMap.set(lbl.name.toLowerCase(), created.id);
      }

      // 4. Seed initial work items
      const rawWorkItems = (template.initialWorkItems as unknown as InitialWorkItemDto[]) || [];
      let sequence = 0;

      for (const wi of rawWorkItems) {
        sequence++;
        await tx.workItem.create({
          data: {
            projectId: project.id,
            title: wi.title,
            content: wi.description || '',
            priority: (wi.priority as any) || 'medium',
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
