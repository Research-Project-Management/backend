import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { StatusUpdateService } from '@/modules/project/status-update/status-update.service';
import { StatusUpdateRepository } from '@/modules/project/status-update/status-update.repository';
import { ProjectUpdateStatus } from '@prisma/client';

describe('StatusUpdateService', () => {
  let service: StatusUpdateService;
  let repo: jest.Mocked<StatusUpdateRepository>;

  beforeEach(async () => {
    const mockRepo = {
      findManyByProjectId: jest.fn(),
      findLatestByProjectId: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatusUpdateService,
        { provide: StatusUpdateRepository, useValue: mockRepo },
      ],
    }).compile();

    service = module.get<StatusUpdateService>(StatusUpdateService);
    repo = module.get(StatusUpdateRepository);
  });

  it('should list all status updates for a project in order', async () => {
    const mockUpdates = [
      {
        id: 'u-1',
        projectId: 'p-1',
        status: ProjectUpdateStatus.on_track,
        message: 'On track as expected',
        createdById: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: { id: 'user-1', name: 'Alice', avatar: null },
      },
      {
        id: 'u-2',
        projectId: 'p-1',
        status: ProjectUpdateStatus.at_risk,
        message: 'Waiting for paper review',
        createdById: 'user-2',
        createdAt: new Date(Date.now() - 100000),
        updatedAt: new Date(Date.now() - 100000),
        createdBy: { id: 'user-2', name: 'Bob', avatar: null },
      },
    ];

    repo.findManyByProjectId.mockResolvedValue(mockUpdates as any);

    const result = await service.getUpdates('p-1');
    expect(result).toHaveLength(2);
    expect(result[0].status).toBe(ProjectUpdateStatus.on_track);
    expect(result[0].author.name).toBe('Alice');
    expect(repo.findManyByProjectId).toHaveBeenCalledWith('p-1');
  });

  it('should get the latest status update', async () => {
    const mockLatest = {
      id: 'u-1',
      projectId: 'p-1',
      status: ProjectUpdateStatus.off_track,
      message: 'Critical blocker on dataset ingestion',
      createdById: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: { id: 'user-1', name: 'Alice', avatar: null },
    };

    repo.findLatestByProjectId.mockResolvedValue(mockLatest as any);

    const result = await service.getLatestUpdate('p-1');
    expect(result).not.toBeNull();
    expect(result?.status).toBe(ProjectUpdateStatus.off_track);
    expect(result?.message).toContain('Critical blocker');
  });

  it('should create a new status update', async () => {
    const dto = {
      status: ProjectUpdateStatus.on_track,
      message: 'Completed Phase 1 successfully',
    };

    const created = {
      id: 'u-3',
      projectId: 'p-1',
      status: dto.status,
      message: dto.message,
      createdById: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: { id: 'user-1', name: 'Alice', avatar: null },
    };

    repo.create.mockResolvedValue(created as any);

    const result = await service.createUpdate('p-1', 'user-1', dto);
    expect(result.id).toBe('u-3');
    expect(result.status).toBe(ProjectUpdateStatus.on_track);
    expect(repo.create).toHaveBeenCalledWith('p-1', 'user-1', dto);
  });

  it('should update an existing status update if project matches', async () => {
    repo.findById.mockResolvedValue({
      id: 'u-1',
      projectId: 'p-1',
    } as any);

    repo.update.mockResolvedValue({
      id: 'u-1',
      projectId: 'p-1',
      status: ProjectUpdateStatus.at_risk,
      message: 'Updated message',
      createdById: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: { id: 'user-1', name: 'Alice', avatar: null },
    } as any);

    const result = await service.updateUpdate('p-1', 'u-1', {
      status: ProjectUpdateStatus.at_risk,
      message: 'Updated message',
    });

    expect(result.status).toBe(ProjectUpdateStatus.at_risk);
    expect(result.message).toBe('Updated message');
  });

  it('should throw NotFoundException when updating non-existent update or wrong project', async () => {
    repo.findById.mockResolvedValue(null);

    await expect(
      service.updateUpdate('p-1', 'unknown-id', { message: 'test' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('should delete a status update successfully', async () => {
    repo.findById.mockResolvedValue({
      id: 'u-1',
      projectId: 'p-1',
    } as any);
    repo.delete.mockResolvedValue({} as any);

    const result = await service.deleteUpdate('p-1', 'u-1');
    expect(result).toEqual({ success: true });
    expect(repo.delete).toHaveBeenCalledWith('u-1');
  });
});
