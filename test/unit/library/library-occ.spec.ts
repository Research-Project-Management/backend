import { Test, TestingModule } from '@nestjs/testing';
import { CommandRepository } from '@/modules/library/catalog/repositories/command.repository';
import { PrismaService } from '@/core/database/prisma.service';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { TransactionService } from '@/modules/library/shared-kernel';
import { VersionMismatchException } from '@/modules/library/shared-kernel/core/errors/version-mismatch.exception';
import { fromPartial } from '@total-typescript/shoehorn';

describe('Library OCC (Optimistic Concurrency Control) Pattern', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const itemId = '22222222-2222-4222-8222-222222222222';

  describe('CommandRepository OCC', () => {
    let repo: CommandRepository;
    let mockPrisma: any;

    beforeEach(async () => {
      mockPrisma = {
        item: {
          findFirst: jest.fn(),
          findUnique: jest.fn(),
          updateMany: jest.fn(),
          update: jest.fn(),
        },
        file: {
          updateMany: jest.fn(),
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CommandRepository,
          {
            provide: PrismaService,
            useValue: mockPrisma,
          },
        ],
      }).compile();

      repo = module.get<CommandRepository>(CommandRepository);
    });

    it('should successfully update and atomically reserve version via updateMany', async () => {
      mockPrisma.item.findFirst.mockResolvedValue({
        id: itemId,
        userId,
        version: 1,
        title: 'Original Title',
        metadata: {},
        notesList: [],
      });

      mockPrisma.item.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.item.update.mockResolvedValue({
        id: itemId,
        userId,
        version: 2,
        title: 'Updated Title',
      });

      const result = await repo.update(userId, itemId, 1, {
        title: 'Updated Title',
      });

      expect(mockPrisma.item.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: itemId,
          version: 1,
          deletedAt: null,
          userId,
        }),
        data: {
          version: { increment: 1 },
        },
      });

      expect(mockPrisma.item.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: itemId },
          data: expect.not.objectContaining({
            version: expect.anything(),
          }),
        }),
      );

      expect(result.version).toBe(2);
    });

    it('should throw VersionMismatchException immediately when expectedVersion does not match in-memory state', async () => {
      mockPrisma.item.findFirst.mockResolvedValue({
        id: itemId,
        userId,
        version: 3,
        title: 'Already updated',
        notesList: [],
      });

      await expect(
        repo.update(userId, itemId, 1, { title: 'Stale Update' }),
      ).rejects.toThrow(VersionMismatchException);

      expect(mockPrisma.item.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.item.update).not.toHaveBeenCalled();
    });

    it('should detect concurrent update race condition when updateMany returns count 0', async () => {
      mockPrisma.item.findFirst.mockResolvedValue({
        id: itemId,
        userId,
        version: 1,
        title: 'Initial',
        notesList: [],
      });

      // Another transaction updated the row concurrently: count is 0
      mockPrisma.item.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.item.findUnique.mockResolvedValue({
        id: itemId,
        version: 2,
      });

      await expect(
        repo.update(userId, itemId, 1, { title: 'Conflicting update' }),
      ).rejects.toThrow(VersionMismatchException);

      expect(mockPrisma.item.update).not.toHaveBeenCalled();
    });

    it('should perform softDelete with atomic expectedVersion guard', async () => {
      mockPrisma.item.updateMany.mockResolvedValue({ count: 1 });

      const success = await repo.softDelete(userId, itemId, 1);
      expect(success).toBe(true);

      expect(mockPrisma.item.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: itemId,
          version: 1,
          deletedAt: null,
          userId,
        }),
        data: expect.objectContaining({
          version: { increment: 1 },
        }),
      });
    });

    it('should throw VersionMismatchException on softDelete if concurrent writer changed version', async () => {
      mockPrisma.item.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.item.findFirst.mockResolvedValue({
        id: itemId,
        version: 2,
      });

      await expect(repo.softDelete(userId, itemId, 1)).rejects.toThrow(
        VersionMismatchException,
      );
    });
  });
});
