import { Injectable, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { WorkItem } from '@prisma/client';
import { UpdateWorkItemDto } from '../dto/update.dto';
import { mapPriority } from '../utils/work-item.util';

@Injectable()
export class EventDispatcher {
  constructor(@Optional() private readonly eventEmitter?: EventEmitter2) {}

  emitWorkItemCreated(params: {
    workItemId: string;
    actorId: string;
    projectId: string;
    columnId: string;
    title?: string;
    identifier?: string | null;
    sequenceNumber?: number | null;
  }) {
    if (!this.eventEmitter) return;

    const payload = {
      entityType: 'work_item',
      entityId: params.workItemId,
      verb: 'created',
      actorId: params.actorId,
      projectId: params.projectId,
      columnId: params.columnId,
      title: params.title,
      identifier: params.identifier,
      sequenceNumber: params.sequenceNumber,
    };
    this.eventEmitter.emit('work-item.created', payload);
  }

  emitWorkItemDeleted(params: {
    workItemId: string;
    actorId?: string;
    projectId: string;
  }) {
    if (!this.eventEmitter) return;

    const payload = {
      entityType: 'work_item',
      entityId: params.workItemId,
      verb: 'deleted',
      actorId: params.actorId || '',
      projectId: params.projectId,
    };
    this.eventEmitter.emit('work-item.deleted', payload);
  }

  emitWorkItemDuplicated(params: {
    workItemId: string;
    actorId: string;
    projectId: string;
  }) {
    if (!this.eventEmitter) return;

    const payload = {
      entityType: 'work_item',
      entityId: params.workItemId,
      verb: 'created',
      actorId: params.actorId,
      projectId: params.projectId,
    };
    this.eventEmitter.emit('work-item.duplicated', payload);
  }

  emitWorkItemReordered(params: {
    workItemId: string;
    projectId: string;
    columnId: string;
    rank: number;
    actorId?: string;
  }) {
    if (!this.eventEmitter) return;

    const payload = {
      entityType: 'work_item',
      entityId: params.workItemId,
      verb: 'reordered',
      actorId: params.actorId || '',
      projectId: params.projectId,
      columnId: params.columnId,
      rank: params.rank,
    };
    this.eventEmitter.emit('work-item.reordered', payload);
    this.eventEmitter.emit('work-item.updated', {
      ...payload,
      verb: 'updated',
    });
  }

  emitWorkItemArchived(params: {
    workItemId: string;
    identifier?: string | null;
    projectId: string;
    userId: string;
  }) {
    if (!this.eventEmitter) return;
    this.eventEmitter.emit('work-item.archived', params);
    this.eventEmitter.emit('work-item.updated', {
      entityType: 'work_item',
      entityId: params.workItemId,
      verb: 'archived',
      actorId: params.userId,
      projectId: params.projectId,
    });
  }

  emitWorkItemRestored(params: {
    workItemId: string;
    identifier?: string | null;
    projectId: string;
    userId: string;
  }) {
    if (!this.eventEmitter) return;
    this.eventEmitter.emit('work-item.restored', params);
    this.eventEmitter.emit('work-item.updated', {
      entityType: 'work_item',
      entityId: params.workItemId,
      verb: 'restored',
      actorId: params.userId,
      projectId: params.projectId,
    });
  }

  emitWorkItemAssigned(params: {
    workItemId: string;
    projectId: string;
    actorId?: string;
    previousAssigneeId?: string | null;
    newAssigneeId?: string | null;
  }) {
    if (!this.eventEmitter) return;
    this.eventEmitter.emit('work-item.assigned', {
      entityType: 'work_item',
      entityId: params.workItemId,
      workItemId: params.workItemId,
      verb: 'assigned',
      field: 'assigneeId',
      oldValue: params.previousAssigneeId || undefined,
      newValue: params.newAssigneeId,
      actorId: params.actorId || '',
      projectId: params.projectId,
    });
  }

  dispatchUpdateEvents(
    existing: WorkItem,
    updateDto: UpdateWorkItemDto,
    userId?: string,
  ) {
    if (!this.eventEmitter) return;

    const baseEvent = {
      entityType: 'work_item',
      entityId: existing.id,
      actorId: userId || '',
      projectId: existing.projectId,
    };

    if (
      updateDto.columnId !== undefined &&
      updateDto.columnId !== existing.columnId
    ) {
      this.eventEmitter.emit('work-item.state.changed', {
        ...baseEvent,
        verb: 'transitioned',
        field: 'state',
        oldValue: existing.columnId,
        newValue: updateDto.columnId,
      });
    }

    if (updateDto.priority !== undefined) {
      const newPriority = mapPriority(updateDto.priority);
      if (newPriority !== existing.priority) {
        this.eventEmitter.emit('work-item.priority.changed', {
          ...baseEvent,
          verb: 'updated',
          field: 'priority',
          oldValue: existing.priority,
          newValue: newPriority,
        });
      }
    }

    if (updateDto.title !== undefined && updateDto.title !== existing.title) {
      this.eventEmitter.emit('work-item.title.changed', {
        ...baseEvent,
        verb: 'updated',
        field: 'title',
        oldValue: existing.title,
        newValue: updateDto.title,
      });
    }

    const newContent = updateDto.description ?? updateDto.content;
    if (newContent !== undefined && newContent !== (existing.content || '')) {
      this.eventEmitter.emit('work-item.content.changed', {
        ...baseEvent,
        verb: 'updated',
        field: 'description',
        oldValue: existing.content || '',
        newValue: newContent,
      });
    }

    this.eventEmitter.emit('work-item.updated', {
      ...baseEvent,
      verb: 'updated',
    });
  }

  emitBulkUpdated(projectId: string, userId?: string, itemIds?: string[]) {
    this.eventEmitter?.emit('work-item.bulk-updated', {
      entityType: 'project',
      entityId: projectId,
      itemIds: itemIds || [],
      verb: 'updated',
      actorId: userId || '',
      projectId,
    });
    this.eventEmitter?.emit('work-item.updated', {
      entityType: 'project',
      entityId: projectId,
      verb: 'bulk_updated',
      actorId: userId || '',
      projectId,
    });
  }

  emitBulkDeleted(projectId: string, userId?: string, itemIds?: string[]) {
    this.eventEmitter?.emit('work-item.bulk-deleted', {
      entityType: 'project',
      entityId: projectId,
      itemIds: itemIds || [],
      verb: 'deleted',
      actorId: userId || '',
      projectId,
    });
    this.eventEmitter?.emit('work-item.deleted', {
      entityType: 'project',
      entityId: projectId,
      verb: 'bulk_deleted',
      actorId: userId || '',
      projectId,
    });
  }
}

export const WorkItemEventDispatcher = EventDispatcher;
export type WorkItemEventDispatcher = EventDispatcher;
