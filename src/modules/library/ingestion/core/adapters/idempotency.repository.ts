import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../../core/database/prisma.service';
import { IdempotencyRecord, Prisma } from '@prisma/client';
import * as crypto from 'crypto';

export type ClaimResult =
  | { status: 'acquired'; leaseToken: string }
  | { status: 'cached'; record: IdempotencyRecord }
  | { status: 'in_progress' }
  | { status: 'mismatch' };

/**
 * Helper to determine if a database error is strictly a unique constraint violation
 * on the idempotency table's (scopeId, idempotencyKey) compound key.
 */
export function isIdempotencyUniqueViolation(error: unknown): boolean {
  if (!error) return false;
  const anyErr = error as any;

  const isP2002 =
    anyErr?.code === 'P2002' ||
    (anyErr instanceof Prisma.PrismaClientKnownRequestError &&
      anyErr.code === 'P2002');

  if (!isP2002) return false;

  const driverErr = anyErr?.meta?.driverAdapterError;
  const driverCause = driverErr?.cause;

  const target =
    anyErr?.meta?.target ||
    driverCause?.constraint?.fields ||
    driverCause?.fields ||
    (typeof driverCause?.constraint === 'string'
      ? driverCause.constraint
      : undefined);

  // 1. Target array or comma-separated target fields check
  let targetFields: string[] | null = null;
  if (Array.isArray(target) && target.length > 0) {
    targetFields = target.map((t) => String(t));
  } else if (typeof target === 'string' && target.includes(',')) {
    targetFields = target.replace(/[()]/g, '').split(',');
  }

  if (targetFields && targetFields.length > 0) {
    const norm = targetFields.map((t: unknown) =>
      String(t)
        .toLowerCase()
        .replace(/[`"'\s]/g, ''),
    );
    const hasScope = norm.includes('scopeid') || norm.includes('scope_id');
    const hasKey =
      norm.includes('idempotencykey') || norm.includes('idempotency_key');
    if (hasScope && hasKey && norm.length === 2) {
      return true;
    }
    return false;
  }

  // 2. Specific known unique constraint name strings for scopeId + idempotencyKey
  const rawConstraint =
    (typeof target === 'string' && target.trim().length > 0
      ? target
      : undefined) ||
    anyErr?.meta?.constraint ||
    (typeof driverCause?.constraint === 'string'
      ? driverCause.constraint
      : undefined) ||
    driverCause?.originalMessage;

  const constraintStr = String(rawConstraint || '')
    .toLowerCase()
    .replace(/[`"'\s]/g, '');

  if (!constraintStr) {
    return false;
  }

  const KNOWN_CONSTRAINTS = [
    'idempotency_records_scope_id_idempotency_key_key',
    'idempotency_record_scope_id_idempotency_key_key',
    'idempotencyrecord_scopeid_idempotencykey_key',
    'idempotency_records_scopeid_idempotencykey_key',
    'scope_id_idempotency_key',
    'scopeid_idempotencykey',
  ];

  for (const known of KNOWN_CONSTRAINTS) {
    if (constraintStr === known || constraintStr.includes(known)) {
      return true;
    }
  }

  return false;
}

@Injectable()
export class IdempotencyRepository {
  private readonly logger = new Logger(IdempotencyRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generates a safe one-way fingerprint for logging idempotency keys without exposing raw tokens.
   */
  static getFingerprint(key: string): string {
    if (!key) return 'anonymous';
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
  }

  async claim(
    scope: { userId: string; projectId?: string } | string,
    idempotencyKey: string,
    requestHash: string,
    ttlSeconds: number = 86400, // 24 hours
  ): Promise<ClaimResult> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const leaseToken = expiresAt.toISOString();
    const keyFingerprint = IdempotencyRepository.getFingerprint(idempotencyKey);
    const userId = typeof scope === 'object' ? scope.userId : scope;
    const projectId = typeof scope === 'object' ? scope.projectId : undefined;

    try {
      await this.prisma.idempotencyRecord.create({
        data: {
          userId,
          projectId: projectId || null,
          idempotencyKey,
          requestHash,
          status: 'in_progress',
          expiresAt,
        },
      });
      return { status: 'acquired', leaseToken };
    } catch (err: any) {
      if (!isIdempotencyUniqueViolation(err)) {
        this.logger.error(
          `Unexpected database error during idempotency claim (key fp: ${keyFingerprint}): ${err?.message}`,
        );
        throw err;
      }

      const existing = await this.prisma.idempotencyRecord.findFirst({
        where: {
          userId,
          projectId: projectId || null,
          idempotencyKey,
        },
      });

      if (!existing) {
        return { status: 'in_progress' };
      }

      if (existing.requestHash !== requestHash) {
        this.logger.warn(
          `Idempotency payload mismatch for user ${userId} / project ${projectId} (key fp: ${keyFingerprint})`,
        );
        return { status: 'mismatch' };
      }

      if (existing.status === 'succeeded') {
        return { status: 'cached', record: existing };
      }

      if (
        existing.status === 'in_progress' &&
        existing.expiresAt > new Date()
      ) {
        return { status: 'in_progress' };
      }

      // Reclaim expired or failed record with atomic conditional update (matching id, status, and exact expiresAt)
      const updateResult = await this.prisma.idempotencyRecord.updateMany({
        where: {
          id: existing.id,
          status: existing.status,
          expiresAt: existing.expiresAt,
        },
        data: {
          status: 'in_progress',
          requestHash,
          expiresAt,
          statusCode: null,
          responseBody: null as any,
        },
      });

      if (updateResult.count > 0) {
        return { status: 'acquired', leaseToken };
      }

      return { status: 'in_progress' };
    }
  }

  async markSucceededInTx(
    tx: Prisma.TransactionClient,
    scope: { userId: string; projectId?: string } | string,
    idempotencyKey: string,
    statusCode: number,
    responseBody: any,
    leaseToken?: string,
  ): Promise<boolean> {
    const userId = typeof scope === 'object' ? scope.userId : scope;
    const projectId = typeof scope === 'object' ? scope.projectId : undefined;
    const where: Prisma.IdempotencyRecordWhereInput = {
      userId,
      projectId: projectId || null,
      idempotencyKey,
      status: 'in_progress',
    };
    if (leaseToken) {
      where.expiresAt = new Date(leaseToken);
    }
    const res = await tx.idempotencyRecord.updateMany({
      where,
      data: {
        status: 'succeeded',
        statusCode,
        responseBody: responseBody ?? null,
      },
    });
    if (res.count === 0 && leaseToken) {
      this.logger.warn(
        `Lost idempotency lease on markSucceededInTx for user ${userId} / project ${projectId} (key fp: ${IdempotencyRepository.getFingerprint(idempotencyKey)})`,
      );
      return false;
    }
    return res.count > 0;
  }

  async markSucceeded(
    scope: { userId: string; projectId?: string } | string,
    idempotencyKey: string,
    statusCode: number,
    responseBody: any,
    leaseToken?: string,
  ): Promise<boolean> {
    const userId = typeof scope === 'object' ? scope.userId : scope;
    const projectId = typeof scope === 'object' ? scope.projectId : undefined;
    const where: Prisma.IdempotencyRecordWhereInput = {
      userId,
      projectId: projectId || null,
      idempotencyKey,
      status: 'in_progress',
    };
    if (leaseToken) {
      where.expiresAt = new Date(leaseToken);
    }
    const res = await this.prisma.idempotencyRecord.updateMany({
      where,
      data: {
        status: 'succeeded',
        statusCode,
        responseBody: responseBody ?? null,
      },
    });
    if (res.count === 0 && leaseToken) {
      this.logger.warn(
        `Lost idempotency lease on markSucceeded for user ${userId} / project ${projectId} (key fp: ${IdempotencyRepository.getFingerprint(idempotencyKey)})`,
      );
      return false;
    }
    return res.count > 0;
  }

  async markFailed(
    scope: { userId: string; projectId?: string } | string,
    idempotencyKey: string,
    leaseToken?: string,
  ): Promise<boolean> {
    const userId = typeof scope === 'object' ? scope.userId : scope;
    const projectId = typeof scope === 'object' ? scope.projectId : undefined;
    const where: Prisma.IdempotencyRecordWhereInput = {
      userId,
      projectId: projectId || null,
      idempotencyKey,
      status: 'in_progress',
    };
    if (leaseToken) {
      where.expiresAt = new Date(leaseToken);
    }
    const res = await this.prisma.idempotencyRecord.updateMany({
      where,
      data: {
        status: 'failed',
        statusCode: 500,
      },
    });
    return res.count > 0;
  }

  /**
   * Purges expired idempotency records to prevent table bloat.
   * Scans and deletes records where expiresAt <= now.
   */
  async purgeExpiredRecords(): Promise<number> {
    const now = new Date();
    const result = await this.prisma.idempotencyRecord.deleteMany({
      where: {
        expiresAt: { lte: now },
      },
    });
    if (result.count > 0) {
      this.logger.log(`Purged ${result.count} expired idempotency records.`);
    }
    return result.count;
  }
}
