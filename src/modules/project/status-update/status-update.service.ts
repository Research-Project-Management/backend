import { Injectable, NotFoundException } from '@nestjs/common';
import { StatusUpdateRepository } from './status-update.repository';
import { CreateProjectStatusUpdateDto } from './dto/create-status-update.dto';
import { UpdateProjectStatusUpdateDto } from './dto/update-status-update.dto';

@Injectable()
export class StatusUpdateService {
  constructor(private readonly repo: StatusUpdateRepository) {}

  async getUpdates(projectId: string) {
    const list = await this.repo.findManyByProjectId(projectId);
    return list.map((item) => ({
      id: item.id,
      projectId: item.projectId,
      status: item.status,
      message: item.message,
      createdById: item.createdById,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      author: {
        id: item.createdBy.id,
        name: item.createdBy.profile?.name ?? 'User',
        avatar: item.createdBy.profile?.avatar ?? null,
      },
    }));
  }

  async getLatestUpdate(projectId: string) {
    const item = await this.repo.findLatestByProjectId(projectId);
    if (!item) return null;

    return {
      id: item.id,
      projectId: item.projectId,
      status: item.status,
      message: item.message,
      createdById: item.createdById,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      author: {
        id: item.createdBy.id,
        name: item.createdBy.profile?.name ?? 'User',
        avatar: item.createdBy.profile?.avatar ?? null,
      },
    };
  }

  async createUpdate(
    projectId: string,
    userId: string,
    dto: CreateProjectStatusUpdateDto,
  ) {
    const item = await this.repo.create(projectId, userId, dto);
    return {
      id: item.id,
      projectId: item.projectId,
      status: item.status,
      message: item.message,
      createdById: item.createdById,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      author: {
        id: item.createdBy.id,
        name: item.createdBy.profile?.name ?? 'User',
        avatar: item.createdBy.profile?.avatar ?? null,
      },
    };
  }

  async updateUpdate(
    projectId: string,
    updateId: string,
    dto: UpdateProjectStatusUpdateDto,
  ) {
    const existing = await this.repo.findById(updateId);
    if (!existing || existing.projectId !== projectId) {
      throw new NotFoundException(
        `Status update "${updateId}" not found in project "${projectId}"`,
      );
    }

    const item = await this.repo.update(updateId, dto);
    return {
      id: item.id,
      projectId: item.projectId,
      status: item.status,
      message: item.message,
      createdById: item.createdById,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      author: {
        id: item.createdBy.id,
        name: item.createdBy.profile?.name ?? 'User',
        avatar: item.createdBy.profile?.avatar ?? null,
      },
    };
  }

  async deleteUpdate(projectId: string, updateId: string) {
    const existing = await this.repo.findById(updateId);
    if (!existing || existing.projectId !== projectId) {
      throw new NotFoundException(
        `Status update "${updateId}" not found in project "${projectId}"`,
      );
    }

    await this.repo.delete(updateId);
    return { success: true };
  }
}
