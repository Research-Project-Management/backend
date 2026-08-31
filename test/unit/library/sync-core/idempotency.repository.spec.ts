import {
  IdempotencyRepository,
  isIdempotencyUniqueViolation,
} from '../../../../src/modules/library/sync/repositories/idempotency.repository';
import { PrismaService } from '../../../../src/core/database/prisma.service';
import { Prisma } from '@prisma/client';

describe('IdempotencyRepository Unit & Concurrency Safety', () => {
  let repository: IdempotencyRepository;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      idempotencyRecord: {
        create: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    repository = new IdempotencyRepository(mockPrisma as PrismaService);
  });

  const workspaceId = 'ws-test-123';
  const idempotencyKey = 'key-uuid-999';
  const requestHashA = 'hash-sha256-aaa';
  const requestHashB = 'hash-sha256-bbb';

  describe('isIdempotencyUniqueViolation helper', () => {
    it('returns true for array target [workspaceId, idempotencyKey]', () => {
      const error = new Prisma.PrismaClientKnownRequestError('P2002', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: ['workspaceId', 'idempotencyKey'] },
      });
      expect(isIdempotencyUniqueViolation(error)).toBe(true);
    });

    it('returns true for array target [workspace_id, idempotency_key]', () => {
      const error = new Prisma.PrismaClientKnownRequestError('P2002', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: ['workspace_id', 'idempotency_key'] },
      });
      expect(isIdempotencyUniqueViolation(error)).toBe(true);
    });

    it('returns true for known constraint string idempotency_records_workspace_id_idempotency_key_key', () => {
      const error = new Prisma.PrismaClientKnownRequestError('P2002', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: {
          target: 'idempotency_records_workspace_id_idempotency_key_key',
        },
      });
      expect(isIdempotencyUniqueViolation(error)).toBe(true);
    });

    it('returns false for dedup claim unique constraint', () => {
      const error = new Prisma.PrismaClientKnownRequestError('P2002', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: {
          target: ['workspaceId', 'claimType', 'claimValue'],
        },
      });
      expect(isIdempotencyUniqueViolation(error)).toBe(false);
    });

    it('returns false for dedup claim constraint string', () => {
      const error = new Prisma.PrismaClientKnownRequestError('P2002', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: {
          constraint:
            'library_dedup_claims_workspace_id_claim_type_claim_value_key',
        },
      });
      expect(isIdempotencyUniqueViolation(error)).toBe(false);
    });

    it('returns false for empty target or non-P2002 error', () => {
      const p2002Empty = new Prisma.PrismaClientKnownRequestError('P2002', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: {},
      });
      expect(isIdempotencyUniqueViolation(p2002Empty)).toBe(false);

      const p2025 = new Prisma.PrismaClientKnownRequestError('P2025', {
        code: 'P2025',
        clientVersion: '5.0.0',
      });
      expect(isIdempotencyUniqueViolation(p2025)).toBe(false);
    });

    it('returns false when error only has modelName without matching target or constraint', () => {
      const error = new Prisma.PrismaClientKnownRequestError('P2002', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: {
          modelName: 'IdempotencyRecord',
          // no target or constraint
        },
      });
      expect(isIdempotencyUniqueViolation(error)).toBe(false);
    });

    it('returns false when error message contains words "workspace" and "idempotency" but target is unrelated', () => {
      const error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint violation on workspace and idempotency in table other_records',
        {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: {
            target: ['otherField'],
          },
        },
      );
      expect(isIdempotencyUniqueViolation(error)).toBe(false);
    });

    it('returns false for targetless P2002 with message mentioning idempotency', () => {
      const error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on IdempotencyRecord workspace key',
        {
          code: 'P2002',
          clientVersion: '5.0.0',
        },
      );
      expect(isIdempotencyUniqueViolation(error)).toBe(false);
    });

    it('returns false when target has 3 fields including workspaceId and idempotencyKey plus a third field', () => {
      const error = new Prisma.PrismaClientKnownRequestError('P2002', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: {
          target: ['workspaceId', 'idempotencyKey', 'extraField'],
        },
      });
      expect(isIdempotencyUniqueViolation(error)).toBe(false);
    });
  });

  describe('1. First Request Claim (Acquired)', () => {
    it('successfully acquires lock on fresh key insertion', async () => {
      mockPrisma.idempotencyRecord.create.mockResolvedValueOnce({
        id: 'rec-1',
        workspaceId,
        idempotencyKey,
        requestHash: requestHashA,
        status: 'in_progress',
        expiresAt: new Date(Date.now() + 86400000),
      });

      const res = await repository.claim(
        workspaceId,
        idempotencyKey,
        requestHashA,
      );
      expect(res.status).toBe('acquired');
      expect(mockPrisma.idempotencyRecord.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('2. Concurrent Contention & Unique Constraint P2002', () => {
    it('handles unique constraint contention (P2002) and returns in_progress for ongoing execution', async () => {
      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: { target: ['workspaceId', 'idempotencyKey'] },
        },
      );
      mockPrisma.idempotencyRecord.create.mockRejectedValueOnce(p2002Error);
      mockPrisma.idempotencyRecord.findUnique.mockResolvedValueOnce({
        id: 'rec-1',
        workspaceId,
        idempotencyKey,
        requestHash: requestHashA,
        status: 'in_progress',
        expiresAt: new Date(Date.now() + 86400000), // active
      });

      const res = await repository.claim(
        workspaceId,
        idempotencyKey,
        requestHashA,
      );
      expect(res.status).toBe('in_progress');
    });

    it('returns cached response when existing record has succeeded with same payload', async () => {
      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: { target: ['workspaceId', 'idempotencyKey'] },
        },
      );
      mockPrisma.idempotencyRecord.create.mockRejectedValueOnce(p2002Error);
      mockPrisma.idempotencyRecord.findUnique.mockResolvedValueOnce({
        id: 'rec-1',
        workspaceId,
        idempotencyKey,
        requestHash: requestHashA,
        status: 'succeeded',
        statusCode: 200,
        responseBody: { itemId: 'item-100', deduplicated: false },
        expiresAt: new Date(Date.now() + 86400000),
      });

      const res = await repository.claim(
        workspaceId,
        idempotencyKey,
        requestHashA,
      );
      expect(res.status).toBe('cached');
      if (res.status === 'cached') {
        expect(res.record.responseBody).toEqual({
          itemId: 'item-100',
          deduplicated: false,
        });
      }
    });

    it('returns mismatch when existing key was used with different payload hash', async () => {
      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: { target: ['workspaceId', 'idempotencyKey'] },
        },
      );
      mockPrisma.idempotencyRecord.create.mockRejectedValueOnce(p2002Error);
      mockPrisma.idempotencyRecord.findUnique.mockResolvedValueOnce({
        id: 'rec-1',
        workspaceId,
        idempotencyKey,
        requestHash: requestHashA, // different from B
        status: 'succeeded',
        expiresAt: new Date(Date.now() + 86400000),
      });

      const res = await repository.claim(
        workspaceId,
        idempotencyKey,
        requestHashB,
      );
      expect(res.status).toBe('mismatch');
    });

    it('rethrows non-idempotency P2002 error from another table', async () => {
      const foreignP2002 = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on dedup claim',
        {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: { target: ['workspaceId', 'claimType', 'claimValue'] },
        },
      );
      mockPrisma.idempotencyRecord.create.mockRejectedValueOnce(foreignP2002);

      await expect(
        repository.claim(workspaceId, idempotencyKey, requestHashA),
      ).rejects.toThrow(foreignP2002);
    });
  });

  describe('3. Expired Key Atomic Reclaim', () => {
    it('allows only ONE winner to reclaim an expired record with atomic conditional update', async () => {
      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: { target: ['workspaceId', 'idempotencyKey'] },
        },
      );
      mockPrisma.idempotencyRecord.create.mockRejectedValueOnce(p2002Error);
      const expiredDate = new Date(Date.now() - 1000);
      mockPrisma.idempotencyRecord.findUnique.mockResolvedValueOnce({
        id: 'rec-1',
        workspaceId,
        idempotencyKey,
        requestHash: requestHashA,
        status: 'in_progress',
        expiresAt: expiredDate,
      });

      // Simulating winner updateMany count = 1
      mockPrisma.idempotencyRecord.updateMany.mockResolvedValueOnce({
        count: 1,
      });

      const res = await repository.claim(
        workspaceId,
        idempotencyKey,
        requestHashA,
      );
      expect(res.status).toBe('acquired');
      expect(mockPrisma.idempotencyRecord.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'rec-1',
            status: 'in_progress',
            expiresAt: expiredDate,
          }),
        }),
      );
    });

    it('returns in_progress if another concurrent process won the reclaim race (count = 0)', async () => {
      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: { target: ['workspaceId', 'idempotencyKey'] },
        },
      );
      mockPrisma.idempotencyRecord.create.mockRejectedValueOnce(p2002Error);
      const expiredDate = new Date(Date.now() - 1000);
      mockPrisma.idempotencyRecord.findUnique.mockResolvedValueOnce({
        id: 'rec-1',
        workspaceId,
        idempotencyKey,
        requestHash: requestHashA,
        status: 'in_progress',
        expiresAt: expiredDate,
      });

      // Simulating loser updateMany count = 0
      mockPrisma.idempotencyRecord.updateMany.mockResolvedValueOnce({
        count: 0,
      });

      const res = await repository.claim(
        workspaceId,
        idempotencyKey,
        requestHashA,
      );
      expect(res.status).toBe('in_progress');
    });
  });

  describe('4. Mark Succeeded In Transaction and Standalone', () => {
    it('updates status to succeeded and persists responseBody in transaction with matching leaseToken', async () => {
      const leaseToken = new Date(Date.now() + 86400000).toISOString();
      const mockTx = {
        idempotencyRecord: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };

      const success = await repository.markSucceededInTx(
        mockTx as any,
        workspaceId,
        idempotencyKey,
        200,
        { itemId: 'item-xyz', deduplicated: true },
        leaseToken,
      );

      expect(success).toBe(true);
      expect(mockTx.idempotencyRecord.updateMany).toHaveBeenCalledWith({
        where: {
          workspaceId,
          idempotencyKey,
          status: 'in_progress',
          expiresAt: new Date(leaseToken),
        },
        data: {
          status: 'succeeded',
          statusCode: 200,
          responseBody: { itemId: 'item-xyz', deduplicated: true },
        },
      });
    });

    it('rejects stale worker execution when leaseToken expiresAt does not match (count = 0)', async () => {
      const staleLeaseToken = new Date(Date.now() - 5000).toISOString();
      const mockTx = {
        idempotencyRecord: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      };

      const success = await repository.markSucceededInTx(
        mockTx as any,
        workspaceId,
        idempotencyKey,
        200,
        { itemId: 'stale-result' },
        staleLeaseToken,
      );

      expect(success).toBe(false);
    });
  });
});
