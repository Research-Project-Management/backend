import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EntityType } from '@prisma/client';
import { WorklogRepository } from './worklog.repository';
import { CreateWorklogDto } from './dto/create-worklog.dto';
import { UpdateWorklogDto } from './dto/update-worklog.dto';
import { QueryWorklogDto } from './dto/query-worklog.dto';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { WORK_ITEM_REDIS_KEYS } from '../core/constants/redis-keys.constant';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';

@Injectable()
export class WorklogService {
  constructor(
    private readonly worklogRepository: WorklogRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateTaskCache(taskId: string, projectId?: string) {
    if (!this.cache) return;
    const promises: Promise<any>[] = [
      this.cache.del(WORK_ITEM_REDIS_KEYS.task(taskId)),
    ];
    if (projectId) {
      promises.push(this.cache.del(WORK_ITEM_REDIS_KEYS.projectTasks(projectId)));
    }
    await Promise.all(promises).catch(() => {});
  }

  async logWork(taskId: string, userId: string, createWorklogDto: CreateWorklogDto) {
    const task = await this.worklogRepository.findTaskWithProject(taskId);
    if (!task) {
      throw new NotFoundException(`Work item "${taskId}" not found`);
    }

    const hours = Number(createWorklogDto.hours) || 0;
    const minutes = Number(createWorklogDto.minutes) || 0;
    const totalDuration = Math.round((hours + minutes / 60) * 100) / 100;

    if (totalDuration <= 0) {
      throw new BadRequestException('Total logged work time must be greater than 0');
    }

    const date = createWorklogDto.date ? new Date(createWorklogDto.date) : new Date();

    const worklog = await this.worklogRepository.createWorklog({
      hours: totalDuration,
      description: createWorklogDto.description?.trim() || '',
      date,
      taskId: task.id,
      projectId: task.projectId,
      userId,
    });

    const newTimeSpent = await this.worklogRepository.calculateTaskTotalTime(task.id);
    await this.worklogRepository.updateTaskTimeSpent(task.id, newTimeSpent);
    await this.invalidateTaskCache(task.id, task.projectId);

    if (this.eventEmitter) {
      this.eventEmitter.emit('worklog.created', {
        worklogId: worklog.id,
        taskId: task.id,
        projectId: task.projectId,
        userId,
        hours: totalDuration,
      });

      if (task.project?.workspaceId) {
        this.eventEmitter.emit(
          'activity.log',
          new DomainActivityEvent({
            entityType: EntityType.task,
            entityId: task.id,
            verb: 'logged_time',
            field: 'timeSpent',
            oldValue: String(task.timeSpent || 0),
            newValue: String(newTimeSpent),
            actorId: userId,
            workspaceId: task.project.workspaceId,
            projectId: task.projectId,
          }),
        );
      }
    }

    return {
      success: true,
      message: `Logged ${totalDuration} hour(s) on ${task.identifier || task.title}`,
      worklog,
      taskTimeSpent: newTimeSpent,
    };
  }

  async getTaskWorklogs(taskId: string) {
    const task = await this.worklogRepository.findTaskWithProject(taskId);
    if (!task) {
      throw new NotFoundException(`Work item "${taskId}" not found`);
    }

    const worklogs = await this.worklogRepository.findWorklogsByTaskId(task.id);

    return {
      taskId: task.id,
      identifier: task.identifier,
      title: task.title,
      totalHours: task.timeSpent || 0,
      worklogs,
    };
  }

  async updateWorklog(
    worklogId: string,
    userId: string,
    updateWorklogDto: UpdateWorklogDto,
    isProjectAdmin: boolean = false,
  ) {
    const existing = await this.worklogRepository.findWorklogById(worklogId);
    if (!existing) {
      throw new NotFoundException('Worklog not found');
    }

    if (existing.userId !== userId && !isProjectAdmin) {
      throw new ForbiddenException('You do not have permission to edit this worklog');
    }

    let updatedHours: number | undefined;
    if (updateWorklogDto.hours !== undefined || updateWorklogDto.minutes !== undefined) {
      const currentWholeHours = Math.floor(existing.hours);
      const currentMinutes = Math.round((existing.hours - currentWholeHours) * 60);

      const hours = updateWorklogDto.hours !== undefined ? Number(updateWorklogDto.hours) : currentWholeHours;
      const minutes = updateWorklogDto.minutes !== undefined ? Number(updateWorklogDto.minutes) : currentMinutes;
      updatedHours = Math.round((hours + minutes / 60) * 100) / 100;

      if (updatedHours <= 0) {
        throw new BadRequestException('Total logged work time must be greater than 0');
      }
    }

    const updated = await this.worklogRepository.updateWorklog(worklogId, {
      ...(updatedHours !== undefined ? { hours: updatedHours } : {}),
      ...(updateWorklogDto.description !== undefined ? { description: updateWorklogDto.description.trim() } : {}),
      ...(updateWorklogDto.date ? { date: new Date(updateWorklogDto.date) } : {}),
    });

    let newTimeSpent: number | undefined;
    if (existing.taskId) {
      newTimeSpent = await this.worklogRepository.calculateTaskTotalTime(existing.taskId);
      await this.worklogRepository.updateTaskTimeSpent(existing.taskId, newTimeSpent);
      await this.invalidateTaskCache(existing.taskId, existing.projectId);
    }

    if (this.eventEmitter) {
      this.eventEmitter.emit('worklog.updated', {
        worklogId,
        taskId: existing.taskId,
        projectId: existing.projectId,
        userId,
      });
    }

    return {
      success: true,
      message: 'Worklog updated successfully',
      worklog: updated,
      taskTimeSpent: newTimeSpent,
    };
  }

  async deleteWorklog(
    worklogId: string,
    userId: string,
    isProjectAdmin: boolean = false,
  ) {
    const existing = await this.worklogRepository.findWorklogById(worklogId);
    if (!existing) {
      throw new NotFoundException('Worklog not found');
    }

    if (existing.userId !== userId && !isProjectAdmin) {
      throw new ForbiddenException('You do not have permission to delete this worklog');
    }

    await this.worklogRepository.deleteWorklog(worklogId);

    let newTimeSpent = 0;
    if (existing.taskId) {
      newTimeSpent = await this.worklogRepository.calculateTaskTotalTime(existing.taskId);
      await this.worklogRepository.updateTaskTimeSpent(existing.taskId, newTimeSpent);
      await this.invalidateTaskCache(existing.taskId, existing.projectId);
    }

    if (this.eventEmitter) {
      this.eventEmitter.emit('worklog.deleted', {
        worklogId,
        taskId: existing.taskId,
        projectId: existing.projectId,
        userId,
        hoursRemoved: existing.hours,
      });
    }

    return {
      success: true,
      message: 'Worklog entry removed successfully',
      taskTimeSpent: newTimeSpent,
    };
  }

  async getProjectTimesheet(projectId: string, queryWorklogDto: QueryWorklogDto) {
    return this.worklogRepository.findProjectTimesheet(projectId, queryWorklogDto);
  }

  async getWorkspaceTimesheet(workspaceId: string, queryWorklogDto: QueryWorklogDto) {
    return this.worklogRepository.findWorkspaceTimesheet(workspaceId, queryWorklogDto);
  }
}
