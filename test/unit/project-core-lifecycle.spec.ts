import { CoreService } from '@/modules/project/core/core.service';
import { CoreRepository } from '@/modules/project/core/core.repository';
import { ProjectMemberRole } from '@prisma/client';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('Project Module — Core Lifecycle & Zero-Workspace Unit Tests (Matt Pocock Seam 1 & 3)', () => {
  let coreService: CoreService;
  let mockRepo: jest.Mocked<Partial<CoreRepository>>;
  let mockEventEmitter: { emit: jest.Mock };
  let mockRedis: { get: jest.Mock; set: jest.Mock; del: jest.Mock };

  const userId = '11111111-1111-4111-a111-111111111111';
  const projectId = '22222222-2222-4222-a222-222222222222';

  const mockProjectWithMembers: any = {
    id: projectId,
    name: 'Quantum NLP Research',
    identifier: 'QNLP',
    description: 'Investigating quantum algorithms for NLP',
    avatar: 'https://avatar.url',
    coverImage: 'https://cover.url',
    network: 'secret',
    isActive: true,
    createdById: userId,
    modules: ['tasks', 'cycles', 'views', 'pages', 'stickies', 'storage'],
    settings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    members: [
      {
        id: 'pm-1',
        projectId,
        userId,
        role: ProjectMemberRole.owner,
        joinedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        user: {
          id: userId,
          name: 'Lead Scientist',
          email: 'lead@flux.study',
          avatar: null,
        },
      },
    ],
  };

  beforeEach(() => {
    mockRepo = {
      findProjectsByUser: jest.fn().mockResolvedValue([mockProjectWithMembers]),
      findProjectById: jest.fn().mockResolvedValue(mockProjectWithMembers),
      findProjectByIdentifier: jest.fn().mockResolvedValue(null),
      createProject: jest.fn().mockResolvedValue(mockProjectWithMembers),
      updateProject: jest.fn().mockResolvedValue(mockProjectWithMembers),
      softDeleteProject: jest.fn().mockResolvedValue(mockProjectWithMembers),
      allocateTaskIdentifier: jest.fn().mockResolvedValue({
        prefix: 'QNLP',
        sequence: 1,
        fullIdentifier: 'QNLP-1',
      }),
      getProjectSettings: jest.fn().mockResolvedValue({}),
    };

    mockEventEmitter = { emit: jest.fn() };
    mockRedis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    coreService = new CoreService(
      mockRepo as unknown as CoreRepository,
      mockEventEmitter as any,
      mockRedis as any,
    );
  });

  describe('CoreService — Create Project (Zero-Workspace Primitive)', () => {
    it('creates project and assigns creator as owner without workspace hacks', async () => {
      const result = await coreService.create(userId, {
        name: 'Quantum NLP Research',
        identifier: 'QNLP',
        description: 'Investigating quantum algorithms for NLP',
      });

      expect(result.project.id).toBe(projectId);
      expect(result.project.identifier).toBe('QNLP');
      expect(result.project.members?.[0].role).toBe(ProjectMemberRole.owner);
      expect(mockRepo.createProject).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          name: 'Quantum NLP Research',
          identifier: 'QNLP',
        }),
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'project.created',
        expect.objectContaining({
          entityType: 'project',
          verb: 'created',
          projectId,
        }),
      );
    });

    it('rejects creation if identifier already exists', async () => {
      mockRepo.findProjectByIdentifier = jest
        .fn()
        .mockResolvedValue(mockProjectWithMembers);

      await expect(
        coreService.create(userId, {
          name: 'Another Project',
          identifier: 'QNLP',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('CoreService — Retrieve & Query Projects', () => {
    it('findUserProjects returns mapped project collections', async () => {
      const result = await coreService.findUserProjects(userId, { type: 'all' });
      expect(result.projects).toHaveLength(1);
      expect(result.myProjects).toHaveLength(1);
      expect(result.projects[0].identifier).toBe('QNLP');
    });

    it('findById returns project detail and caches to redis', async () => {
      const result = await coreService.findById(projectId, userId);
      expect(result.project.id).toBe(projectId);
      expect(result.yourRole).toBe(ProjectMemberRole.owner);
      expect(mockRedis.set).toHaveBeenCalled();
    });

    it('findById throws NotFoundException when project does not exist', async () => {
      mockRepo.findProjectById = jest.fn().mockResolvedValue(null);

      await expect(coreService.findById('non-existent', userId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('CoreService — Project Lifecycle Updates and Deletion', () => {
    it('update modifies attributes and invalidates cache', async () => {
      const updated = {
        ...mockProjectWithMembers,
        name: 'Quantum NLP (Updated)',
      };
      mockRepo.updateProject = jest.fn().mockResolvedValue(updated);

      const result = await coreService.update(projectId, {
        name: 'Quantum NLP (Updated)',
      });

      expect(result.project.name).toBe('Quantum NLP (Updated)');
      expect(mockRedis.del).toHaveBeenCalled();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'project.updated',
        expect.objectContaining({
          entityType: 'project',
          verb: 'updated',
          projectId,
        }),
      );
    });

    it('softDelete performs soft delete and purges cache', async () => {
      const result = await coreService.softDelete(projectId, userId);
      expect(result.message).toContain('successfully');
      expect(mockRepo.softDeleteProject).toHaveBeenCalledWith(projectId);
      expect(mockRedis.del).toHaveBeenCalled();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'project.deleted',
        expect.objectContaining({
          entityType: 'project',
          verb: 'deleted',
          projectId,
        }),
      );
    });
  });
});
