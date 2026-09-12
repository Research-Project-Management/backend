import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TemplateRepository } from './template.repository';
import { WorkItemService } from '../core/work-item.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { QueryTemplateDto } from './dto/query-template.dto';
import { InstantiateTemplateDto } from './dto/instantiate-template.dto';

@Injectable()
export class TemplateService {
  constructor(
    private readonly templateRepository: TemplateRepository,
    private readonly workItemService: WorkItemService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  async createTemplate(
    projectId: string,
    authorId: string,
    createTemplateDto: CreateTemplateDto,
  ) {
    const canonicalProjectId = await this.templateRepository.resolveProjectId(
      projectId || createTemplateDto.projectId || '',
    );
    if (!canonicalProjectId) {
      throw new NotFoundException('Project not found');
    }

    const template = await this.templateRepository.createTemplate({
      name: createTemplateDto.name.trim(),
      description: createTemplateDto.description?.trim() || '',
      title: createTemplateDto.title?.trim() || '',
      content: createTemplateDto.content || '',
      priority: createTemplateDto.priority || 'none',
      labelIds: createTemplateDto.labelIds || [],
      assigneeIds: createTemplateDto.assigneeIds || [],
      checklists: createTemplateDto.checklists || [],
      isDefault: !!createTemplateDto.isDefault,
      projectId: canonicalProjectId,
      authorId,
    });

    if (createTemplateDto.isDefault) {
      await this.templateRepository.unsetOtherDefaults(canonicalProjectId, template.id);
    }

    if (this.eventEmitter) {
      this.eventEmitter.emit('template.created', {
        templateId: template.id,
        projectId: canonicalProjectId,
        authorId,
      });
    }

    return {
      success: true,
      message: 'Work item template created successfully',
      template,
    };
  }

  async getProjectTemplates(projectId: string, queryTemplateDto: QueryTemplateDto) {
    return this.templateRepository.findTemplatesByProject(projectId, queryTemplateDto);
  }

  async getTemplateById(projectId: string, templateId: string) {
    const template = await this.templateRepository.findTemplateById(templateId);
    if (!template) {
      throw new NotFoundException(`Template "${templateId}" not found`);
    }
    return { template };
  }

  async updateTemplate(
    projectId: string,
    templateId: string,
    authorId: string,
    updateTemplateDto: UpdateTemplateDto,
    isAdmin: boolean = false,
  ) {
    const existing = await this.templateRepository.findTemplateById(templateId);
    if (!existing) {
      throw new NotFoundException(`Template "${templateId}" not found`);
    }

    if (existing.authorId !== authorId && !isAdmin) {
      throw new ForbiddenException('You do not have permission to edit this template');
    }

    const updated = await this.templateRepository.updateTemplate(templateId, {
      ...(updateTemplateDto.name !== undefined ? { name: updateTemplateDto.name.trim() } : {}),
      ...(updateTemplateDto.description !== undefined ? { description: updateTemplateDto.description.trim() } : {}),
      ...(updateTemplateDto.title !== undefined ? { title: updateTemplateDto.title.trim() } : {}),
      ...(updateTemplateDto.content !== undefined ? { content: updateTemplateDto.content } : {}),
      ...(updateTemplateDto.priority !== undefined ? { priority: updateTemplateDto.priority } : {}),
      ...(updateTemplateDto.labelIds !== undefined ? { labelIds: updateTemplateDto.labelIds } : {}),
      ...(updateTemplateDto.assigneeIds !== undefined ? { assigneeIds: updateTemplateDto.assigneeIds } : {}),
      ...(updateTemplateDto.checklists !== undefined ? { checklists: updateTemplateDto.checklists } : {}),
      ...(updateTemplateDto.isDefault !== undefined ? { isDefault: updateTemplateDto.isDefault } : {}),
    });

    if (updateTemplateDto.isDefault) {
      await this.templateRepository.unsetOtherDefaults(existing.projectId, templateId);
    }

    if (this.eventEmitter) {
      this.eventEmitter.emit('template.updated', {
        templateId,
        projectId: existing.projectId,
        authorId,
      });
    }

    return {
      success: true,
      message: 'Template updated successfully',
      template: updated,
    };
  }

  async deleteTemplate(
    projectId: string,
    templateId: string,
    authorId: string,
    isAdmin: boolean = false,
  ) {
    const existing = await this.templateRepository.findTemplateById(templateId);
    if (!existing) {
      throw new NotFoundException(`Template "${templateId}" not found`);
    }

    if (existing.authorId !== authorId && !isAdmin) {
      throw new ForbiddenException('You do not have permission to delete this template');
    }

    await this.templateRepository.softDeleteTemplate(templateId);

    if (this.eventEmitter) {
      this.eventEmitter.emit('template.deleted', {
        templateId,
        projectId: existing.projectId,
        authorId,
      });
    }

    return {
      success: true,
      message: 'Template deleted successfully',
    };
  }

  async instantiateTemplate(
    projectId: string,
    templateId: string,
    authorId: string,
    instantiateTemplateDto: InstantiateTemplateDto,
  ) {
    const template = await this.templateRepository.findTemplateById(templateId);
    if (!template) {
      throw new NotFoundException(`Template "${templateId}" not found`);
    }

    const title =
      instantiateTemplateDto.title?.trim() || template.title?.trim() || template.name;
    const content =
      instantiateTemplateDto.content !== undefined ? instantiateTemplateDto.content : template.content || '';
    const priority = instantiateTemplateDto.priority || template.priority || 'none';
    const labelIds = (template.labelIds as string[]) || [];
    const assigneeIds =
      instantiateTemplateDto.assigneeIds || (template.assigneeIds as string[]) || [];
    const checklists = (template.checklists as any[]) || [];

    const createTaskDto: any = {
      title,
      description: content,
      content,
      priority,
      labelIds,
      assigneeIds,
      ...(instantiateTemplateDto.columnId ? { columnId: instantiateTemplateDto.columnId } : {}),
      ...(instantiateTemplateDto.cycleId ? { cycleId: instantiateTemplateDto.cycleId } : {}),
      ...(instantiateTemplateDto.assigneeId ? { assigneeId: instantiateTemplateDto.assigneeId } : {}),
    };

    const result = await this.workItemService.createTask(
      template.projectId,
      authorId,
      createTaskDto,
    );

    const createdTask = (result as any)?.task || result;

    if (this.eventEmitter) {
      this.eventEmitter.emit('template.instantiated', {
        templateId,
        taskId: createdTask?.id,
        identifier: createdTask?.identifier,
        projectId: template.projectId,
        authorId,
      });
    }

    return {
      success: true,
      message: `Work item "${createdTask?.identifier || title}" created from template "${template.name}"`,
      task: createdTask,
    };
  }
}
