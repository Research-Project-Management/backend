import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OutboxWorker } from '@/modules/library/shared-kernel/outbox/outbox.worker';
import { IdempotencyRepository } from '@/modules/library/ingestion/infrastructure/repositories/idempotency.repository';
import { ChangeLogRepository } from '@/modules/library/shared-kernel/outbox/repositories/changelog.repository';
import { PrismaService } from '@/core/database/prisma.service';
import { OutboxStatus } from '@prisma/client';

describe('Library Phase 4: Infrastructure Hardening & Maintenance Purge', () => {
  let prisma: {
    outboxEvent: {
      deleteMany: jest.Mock;
    };
    idempotencyRecord: {
      deleteMany: jest.Mock;
    };
    libraryChange: {
      deleteMany: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      outboxEvent: {
        deleteMany: jest.fn(),
      },
      idempotencyRecord: {
        deleteMany: jest.fn(),
      },
      libraryChange: {
        deleteMany: jest.fn(),
      },
    };
  });

  describe('OutboxWorker.purgeCompletedEvents', () => {
    let worker: OutboxWorker;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          OutboxWorker,
          { provide: PrismaService, useValue: prisma },
          { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        ],
      }).compile();

      worker = module.get<OutboxWorker>(OutboxWorker);
    });

    it('should purge PUBLISHED outbox events older than retention cutoff', async () => {
      prisma.outboxEvent.deleteMany.mockResolvedValue({ count: 42 });

      const retentionMs = 7 * 24 * 60 * 60 * 1000;
      const count = await worker.purgeCompletedEvents(retentionMs);

      expect(count).toBe(42);
      expect(prisma.outboxEvent.deleteMany).toHaveBeenCalledTimes(1);
      const callArgs = prisma.outboxEvent.deleteMany.mock.calls[0][0];
      expect(callArgs.where.status).toBe(OutboxStatus.PUBLISHED);
      expect(callArgs.where.processedAt.lte).toBeInstanceOf(Date);
    });

    it('should return 0 when no events match the retention cutoff', async () => {
      prisma.outboxEvent.deleteMany.mockResolvedValue({ count: 0 });

      const count = await worker.purgeCompletedEvents();
      expect(count).toBe(0);
    });
  });

  describe('IdempotencyRepository.purgeExpiredRecords', () => {
    let repo: IdempotencyRepository;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          IdempotencyRepository,
          { provide: PrismaService, useValue: prisma },
        ],
      }).compile();

      repo = module.get<IdempotencyRepository>(IdempotencyRepository);
    });

    it('should delete idempotency records where expiresAt <= now', async () => {
      prisma.idempotencyRecord.deleteMany.mockResolvedValue({ count: 15 });

      const count = await repo.purgeExpiredRecords();

      expect(count).toBe(15);
      expect(prisma.idempotencyRecord.deleteMany).toHaveBeenCalledTimes(1);
      const callArgs = prisma.idempotencyRecord.deleteMany.mock.calls[0][0];
      expect(callArgs.where.expiresAt.lte).toBeInstanceOf(Date);
    });
  });

  describe('ChangeLogRepository.purgeOldChanges', () => {
    let repo: ChangeLogRepository;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ChangeLogRepository,
          { provide: PrismaService, useValue: prisma },
        ],
      }).compile();

      repo = module.get<ChangeLogRepository>(ChangeLogRepository);
    });

    it('should delete historical library_changes older than retention window', async () => {
      prisma.libraryChange.deleteMany.mockResolvedValue({ count: 128 });

      const retentionMs = 90 * 24 * 60 * 60 * 1000;
      const count = await repo.purgeOldChanges(retentionMs);

      expect(count).toBe(128);
      expect(prisma.libraryChange.deleteMany).toHaveBeenCalledTimes(1);
      const callArgs = prisma.libraryChange.deleteMany.mock.calls[0][0];
      expect(callArgs.where.createdAt.lte).toBeInstanceOf(Date);
    });
  });
});
