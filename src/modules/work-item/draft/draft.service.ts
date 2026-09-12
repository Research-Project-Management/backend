import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DraftRepository } from './draft.repository';
import { WorkItemService } from '../core/work-item.service';
import { CreateDraftDto } from './dto/create-draft.dto';
import { UpdateDraftDto } from './dto/update-draft.dto';
import { PublishDraftDto } from './dto/publish-draft.dto';
import { QueryDraftDto } from './dto/query-draft.dto';

@Injectable()
export class DraftService {
  private readonly logger = new Logger(DraftService.name);

  constructor(
    private readonly draftRepository: DraftRepository,
    private readonly workItemService: WorkItemService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  async createDraft(createDraftDto: CreateDraftDto, authorId: string) {
    const draft = await this.draftRepository.create(createDraftDto, authorId);
    this.eventEmitter?.emit('draft.created', {
      draftId: draft.id,
      authorId,
      projectId: draft.projectId,
    });
    return draft;
  }

  async getDraft(id: string, authorId: string) {
    const draft = await this.draftRepository.findById(id, authorId);
    if (!draft) {
      throw new NotFoundException(`Draft ${id} not found`);
    }
    return draft;
  }

  async getUserDrafts(authorId: string, queryDraftDto: QueryDraftDto) {
    const page = Number(queryDraftDto.page) || 1;
    const limit = Number(queryDraftDto.limit) || 50;
    const skip = (page - 1) * limit;

    return this.draftRepository.findUserDrafts(
      authorId,
      { projectId: queryDraftDto.projectId, search: queryDraftDto.search },
      skip,
      limit,
    );
  }

  async updateDraft(id: string, updateDraftDto: UpdateDraftDto, authorId: string) {
    const existing = await this.draftRepository.findById(id, authorId);
    if (!existing) {
      throw new NotFoundException(`Draft ${id} not found`);
    }
    return this.draftRepository.update(id, authorId, updateDraftDto);
  }

  async publishDraft(id: string, publishDraftDto: PublishDraftDto, authorId: string) {
    const draft = await this.draftRepository.findById(id, authorId);
    if (!draft) {
      throw new NotFoundException(`Draft ${id} not found`);
    }

    const targetProjectId = publishDraftDto.projectId || draft.projectId;
    if (!targetProjectId) {
      throw new BadRequestException(
        'Project ID is required to publish a draft into a work item',
      );
    }

    const title = publishDraftDto.title || draft.title || 'Untitled';

    const targetColumn = publishDraftDto.columnId || draft.columnId || 'backlog';

    const result = await this.workItemService.createTask(
      targetProjectId,
      authorId,
      {
        title,
        content: draft.content || draft.description || '',
        description: draft.description || draft.content || '',
        columnId: targetColumn,
        priority: publishDraftDto.priority || draft.priority,
        startDate: draft.startDate ? draft.startDate.toISOString() : undefined,
        dueDate: draft.dueDate ? draft.dueDate.toISOString() : undefined,
        labels: draft.labels,
        assigneeId: draft.assigneeId || undefined,
        cycleId: publishDraftDto.cycleId || undefined,
      },
    );

    await this.draftRepository.delete(id, authorId);

    const publishedTask = result?.task;

    this.eventEmitter?.emit('draft.published', {
      draftId: id,
      taskId: publishedTask?.id,
      projectId: targetProjectId,
      authorId,
    });

    return result;
  }

  async duplicateDraft(id: string, authorId: string) {
    const draft = await this.draftRepository.findById(id, authorId);
    if (!draft) {
      throw new NotFoundException(`Draft ${id} not found`);
    }

    const title = draft.title ? `${draft.title} (Copy)` : 'Untitled (Copy)';

    const duplicated = await this.draftRepository.create(
      {
        title,
        content: draft.content || draft.description || '',
        description: draft.description || draft.content || '',
        columnId: draft.columnId || undefined,
        priority: draft.priority,
        startDate: draft.startDate ? draft.startDate.toISOString() : undefined,
        dueDate: draft.dueDate ? draft.dueDate.toISOString() : undefined,
        labels: draft.labels,
        assigneeId: draft.assigneeId || undefined,
        assigneeIds: Array.isArray(draft.assigneeIds)
          ? (draft.assigneeIds as string[])
          : undefined,
        metadata: (draft.metadata as Record<string, any>) || undefined,
        projectId: draft.projectId || undefined,
      },
      authorId,
    );

    this.eventEmitter?.emit('draft.created', {
      draftId: duplicated.id,
      authorId,
      projectId: duplicated.projectId,
    });

    return duplicated;
  }

  async deleteDraft(id: string, authorId: string) {
    const existing = await this.draftRepository.findById(id, authorId);
    if (!existing) {
      throw new NotFoundException(`Draft ${id} not found`);
    }
    await this.draftRepository.delete(id, authorId);
    return { success: true, id };
  }
}

