import { RelationService } from '@/modules/work-item/relation/relation.service';
import { RelationRepository } from '@/modules/work-item/relation/relation.repository';
import { BadRequestException } from '@nestjs/common';

describe('WorkItem Relation Service & DAG Cycle Detection', () => {
  let relationService: RelationService;
  let mockRelationRepository: any;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      $transaction: jest.fn().mockImplementation((cb) => cb(mockPrisma)),
      workItem: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      workItemRelation: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    mockRelationRepository = {
      prisma: mockPrisma,
      findWorkItem: jest.fn(),
      findWorkItemsByIds: jest.fn(),
      updateWorkItemRelations: jest.fn(),
      executeTransaction: jest.fn(),
    };

    relationService = new RelationService(mockRelationRepository);
  });

  it('should reject linking work item to itself', async () => {
    mockRelationRepository.findWorkItem.mockImplementation((id: string) =>
      Promise.resolve({ id: 'item-1', projectId: 'proj-1', relations: [] }),
    );

    await expect(
      relationService.addRelation('item-1', {
        targetWorkItemId: 'item-1',
        type: 'blocks',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should detect direct cycle: A blocks B, and B attempts to block A', async () => {
    mockRelationRepository.findWorkItem.mockImplementation((id: string) => {
      if (id === 'item-A') {
        return Promise.resolve({ id: 'item-A', projectId: 'proj-1', relations: [] });
      }
      if (id === 'item-B') {
        return Promise.resolve({ id: 'item-B', projectId: 'proj-1', relations: [] });
      }
      return Promise.resolve(null);
    });

    // When checking path from item-A to item-B:
    // item-A already blocks item-B in the database
    mockPrisma.workItemRelation.findMany.mockImplementation((args: any) => {
      const orClauses = args.where?.OR || [];
      const isCheckingA = orClauses.some((c: any) => c.sourceId === 'item-A');
      if (isCheckingA) {
        return Promise.resolve([
          { sourceId: 'item-A', targetId: 'item-B', type: 'blocks' },
        ]);
      }
      return Promise.resolve([]);
    });

    // Now B attempts to block A -> should detect cycle and throw BadRequestException
    await expect(
      relationService.addRelation('item-B', {
        targetWorkItemId: 'item-A',
        type: 'blocks',
      }),
    ).rejects.toThrow('Circular dependency detected');
  });

  it('should detect transitive cycle: A blocks B, B blocks C, and C attempts to block A', async () => {
    mockRelationRepository.findWorkItem.mockImplementation((id: string) =>
      Promise.resolve({ id, projectId: 'proj-1', relations: [] }),
    );

    // Existing graph: A -> B -> C
    mockPrisma.workItemRelation.findMany.mockImplementation((args: any) => {
      const orClauses = args.where?.OR || [];
      if (orClauses.some((c: any) => c.sourceId === 'item-A')) {
        return Promise.resolve([{ sourceId: 'item-A', targetId: 'item-B', type: 'blocks' }]);
      }
      if (orClauses.some((c: any) => c.sourceId === 'item-B')) {
        return Promise.resolve([{ sourceId: 'item-B', targetId: 'item-C', type: 'blocks' }]);
      }
      return Promise.resolve([]);
    });

    // C attempts to block A -> directed edge C -> A would close the loop A -> B -> C -> A
    await expect(
      relationService.addRelation('item-C', {
        targetWorkItemId: 'item-A',
        type: 'blocks',
      }),
    ).rejects.toThrow('Circular dependency detected');
  });

  it('should allow valid non-cyclic relation and execute within atomic transaction', async () => {
    mockRelationRepository.findWorkItem.mockImplementation((id: string) =>
      Promise.resolve({ id, projectId: 'proj-1', relations: [] }),
    );
    mockPrisma.workItemRelation.findMany.mockResolvedValue([]);

    const result = await relationService.addRelation('item-A', {
      targetWorkItemId: 'item-B',
      type: 'blocks',
    });

    expect(result.success).toBe(true);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.workItemRelation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          sourceId: 'item-A',
          targetId: 'item-B',
          type: 'blocks',
        }),
      }),
    );
  });
});
