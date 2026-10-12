import { CoreRepository } from '@/modules/work-item/core/core.repository';
import { PrismaService } from '@/core';

describe('WorkItem Creation & State Connect Type Safety', () => {
  let repository: CoreRepository;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      project: {
        update: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      workItem: {
        create: jest
          .fn()
          .mockImplementation((args) => Promise.resolve(args.data)),
        update: jest
          .fn()
          .mockImplementation((args) => Promise.resolve(args.data)),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      workItemLabel: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    repository = new CoreRepository(mockPrisma);
  });

  describe('CoreRepository.createWorkItem', () => {
    it('should map columnId to state.connect and delete scalar columnId when relation connects are present', async () => {
      const input = {
        title: 'Task 1',
        content: '',
        columnId: '326b4b76-cc73-4788-894d-aea0e0301507',
        project: { connect: { id: '4e61078c-0073-4d42-9970-75e5e106286a' } },
        author: { connect: { id: '3f3fb23b-2193-4763-84e5-c934a10b3cd9' } },
      };

      await repository.createWorkItem(input);

      expect(mockPrisma.workItem.create).toHaveBeenCalledTimes(1);
      const callArgs = mockPrisma.workItem.create.mock.calls[0][0];

      // Must NOT contain scalar columnId (which causes PrismaClientValidationError)
      expect(callArgs.data.columnId).toBeUndefined();
      // Must connect through state relation
      expect(callArgs.data.state).toEqual({
        connect: { id: '326b4b76-cc73-4788-894d-aea0e0301507' },
      });
      expect(callArgs.data.project).toEqual({
        connect: { id: '4e61078c-0073-4d42-9970-75e5e106286a' },
      });
    });

    it('should preserve scalar columnId when unchecked scalar inputs (no relation connect) are used', async () => {
      const input = {
        title: 'Cloned Task',
        content: '',
        columnId: '326b4b76-cc73-4788-894d-aea0e0301507',
        projectId: '4e61078c-0073-4d42-9970-75e5e106286a',
        authorId: '3f3fb23b-2193-4763-84e5-c934a10b3cd9',
      };

      await repository.createWorkItem(input);

      expect(mockPrisma.workItem.create).toHaveBeenCalledTimes(1);
      const callArgs = mockPrisma.workItem.create.mock.calls[0][0];

      expect(callArgs.data.columnId).toBe(
        '326b4b76-cc73-4788-894d-aea0e0301507',
      );
      expect(callArgs.data.state).toBeUndefined();
    });
  });

  describe('CoreRepository.updateWorkItem', () => {
    it('should map columnId to state.connect and delete scalar columnId when relation connects are present', async () => {
      const updateInput = {
        columnId: 'be2e87e3-0b7b-4009-adab-e4470c9554a9',
        assignee: { connect: { id: 'user-123' } },
      };

      await repository.updateWorkItem('item-123', updateInput);

      expect(mockPrisma.workItem.update).toHaveBeenCalledTimes(1);
      const callArgs = mockPrisma.workItem.update.mock.calls[0][0];

      expect(callArgs.data.columnId).toBeUndefined();
      expect(callArgs.data.state).toEqual({
        connect: { id: 'be2e87e3-0b7b-4009-adab-e4470c9554a9' },
      });
    });
  });

  describe('CoreRepository.findLabelsByIds', () => {
    const projectId = '01a1078c-3162-723a-b454-814b8af5f5ec';

    it('should query by name when given non-UUID strings to prevent Postgres 22P02 uuid syntax error', async () => {
      await repository.findLabelsByIds(projectId, [
        'Deep Learning',
        'Optimization',
      ]);

      expect(mockPrisma.workItemLabel.findMany).toHaveBeenCalledTimes(1);
      const callArgs = mockPrisma.workItemLabel.findMany.mock.calls[0][0];

      expect(callArgs.where.AND[0]).toEqual({ projectId });
      expect(callArgs.where.AND[1]).toEqual({
        name: { in: ['Deep Learning', 'Optimization'] },
      });
    });

    it('should query by id when given valid UUIDs', async () => {
      const uuid1 = '01a1078c-3162-723a-b454-814b8af5f5ec';
      const uuid2 = '88e686b9-1226-4b65-abbf-5cd319ba61b2';
      await repository.findLabelsByIds(projectId, [uuid1, uuid2]);

      expect(mockPrisma.workItemLabel.findMany).toHaveBeenCalledTimes(1);
      const callArgs = mockPrisma.workItemLabel.findMany.mock.calls[0][0];

      expect(callArgs.where.AND[0]).toEqual({ projectId });
      expect(callArgs.where.AND[1]).toEqual({ id: { in: [uuid1, uuid2] } });
    });

    it('should combine OR queries when given a mix of UUIDs and label names', async () => {
      const validUuid = '88e686b9-1226-4b65-abbf-5cd319ba61b2';
      await repository.findLabelsByIds(projectId, [
        validUuid,
        'GPU Cluster & HPC',
      ]);

      expect(mockPrisma.workItemLabel.findMany).toHaveBeenCalledTimes(1);
      const callArgs = mockPrisma.workItemLabel.findMany.mock.calls[0][0];

      expect(callArgs.where.AND[0]).toEqual({ projectId });
      expect(callArgs.where.AND[1]).toEqual({
        OR: [
          { id: { in: [validUuid] } },
          { name: { in: ['GPU Cluster & HPC'] } },
        ],
      });
    });

    it('should return empty array without database call when labelIds is empty', async () => {
      const result = await repository.findLabelsByIds(projectId, []);
      expect(result).toEqual([]);
      expect(mockPrisma.workItemLabel.findMany).not.toHaveBeenCalled();
    });
  });
});
