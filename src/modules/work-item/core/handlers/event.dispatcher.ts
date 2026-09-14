import { Injectable, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
    this.eventEmitter.emit('work-item.updated', { ...payload, verb: 'updated' });
  }

  dispatchUpdateEvents(
    existing: any,
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

    if (
      updateDto.title !== undefined &&
      updateDto.title !== existing.title
    ) {
      this.eventEmitter.emit('work-item.title.changed', {
        ...baseEvent,
        verb: 'updated',
        field: 'title',
        oldValue: existing.title,
        newValue: updateDto.title,
      });
    }

    const newContent =
      updateDto.description ?? updateDto.content;
    if (
      newContent !== undefined &&
      newContent !== (existing.content || '')
    ) {
      this.eventEmitter.emit('work-item.content.changed', {
        ...baseEvent,
        verb: 'updated',
        field: 'description',
        oldValue: existing.content || '',
        newValue: newContent,
      });
    }

    if (
      updateDto.cycleId !== undefined &&
      updateDto.cycleId !== existing.cycleId
    ) {
      this.eventEmitter.emit('work-item.cycle.changed', {
        ...baseEvent,
        verb: 'updated',
        field: 'cycle',
        oldValue: existing.cycleId || '',
        newValue: updateDto.cycleId || '',
      });
    }

    this.eventEmitter.emit('work-item.updated', {
      ...baseEvent,
      verb: 'updated',
    });
  }

  emitBulkUpdated(projectId: string, userId?: string) {
    this.eventEmitter?.emit('work-item.updated', {
      entityType: 'work_item',
      entityId: projectId,
      verb: 'updated',
      actorId: userId || '',
      projectId,
    });
  }

  emitBulkDeleted(projectId: string, userId?: string) {
    this.eventEmitter?.emit('work-item.deleted', {
      entityType: 'work_item',
      entityId: projectId,
      verb: 'deleted',
      actorId: userId || '',
      projectId,
    });
  }
}

export const WorkItemEventDispatcher = EventDispatcher;
export type WorkItemEventDispatcher = EventDispatcher;
