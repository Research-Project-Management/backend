import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';
import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER,
} from '../files.constant';
import { cleanUuid } from '../domain/files.policy';
import { StorageQuotaRecord, UploadSessionStatus } from '../types/files.type';

@Injectable()
export class QuotaRepository {
  private readonly logger = new Logger(QuotaRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async findBySpaceId(
    spaceId?: string | null,
  ): Promise<StorageQuotaRecord | null> {
    const validSpaceId = cleanUuid(spaceId);
    if (!validSpaceId) {
      return null;
    }

    const record = await this.prisma.spaceQuota.findUnique({
      where: {
        spaceId: validSpaceId,
      },
    });
    if (!record) {
      return null;
    }
    return {
      spaceId: record.spaceId,
      usedBytes: record.usedBytes,
      maxBytes: record.maxBytes,
      updatedAt: record.updatedAt,
    };
  }

  async getPendingUploadBytes(spaceId: string): Promise<bigint> {
    const validSpaceId = cleanUuid(spaceId);
    if (
      !validSpaceId ||
      typeof this.prisma.fileUpload?.aggregate !== 'function'
    ) {
      return 0n;
    }

    const agg = await this.prisma.fileUpload.aggregate({
      where: {
        spaceId: validSpaceId,
        status: {
          in: [
            UploadSessionStatus.INITIALIZED,
            UploadSessionStatus.UPLOADING,
            UploadSessionStatus.FINALIZING,
          ],
        },
        expiresAt: { gt: new Date() },
      },
      _sum: {
        totalSize: true,
      },
    });
    return agg._sum?.totalSize ?? 0n;
  }

  async countActiveUserSessions(userId: string): Promise<number> {
    const validUserId = cleanUuid(userId);
    if (!validUserId || typeof this.prisma.fileUpload?.count !== 'function') {
      return 0;
    }

    return this.prisma.fileUpload.count({
      where: {
        createdById: validUserId,
        status: {
          in: [
            UploadSessionStatus.INITIALIZED,
            UploadSessionStatus.UPLOADING,
            UploadSessionStatus.FINALIZING,
          ],
        },
        expiresAt: { gt: new Date() },
      },
    });
  }

  async assertAvailable(
    spaceId: string | null | undefined,
    requiredBytes: bigint,
    options?: { userId?: string; enforceSessionCap?: boolean },
  ): Promise<void> {
    const quota = spaceId ? await this.findBySpaceId(spaceId) : null;
    const maxBytes = quota ? quota.maxBytes : DEFAULT_STORAGE_QUOTA_BYTES;
    const usedBytes = quota ? quota.usedBytes : 0n;
    const pendingBytes = spaceId
      ? await this.getPendingUploadBytes(spaceId)
      : 0n;
    if (usedBytes + pendingBytes + requiredBytes > maxBytes) {
      if (pendingBytes > 0n && usedBytes + requiredBytes <= maxBytes) {
        this.logger.warn(
          `metric=quota_pending_rejected spaceId=${spaceId ?? 'n/a'} pending_bytes=${pendingBytes}`,
        );
      }
      throw new BadRequestException('Storage quota exceeded');
    }

    if (options?.enforceSessionCap && options.userId) {
      const activeCount = await this.countActiveUserSessions(options.userId);
      if (activeCount >= MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER) {
        throw new BadRequestException(
          `Too many active upload sessions (max ${MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER})`,
        );
      }
    }
  }

  async incrementUsage(
    spaceId: string | null | undefined,
    bytes: bigint,
  ): Promise<bigint> {
    const validSpaceId = cleanUuid(spaceId);
    if (!validSpaceId) {
      return 0n;
    }

    if (bytes <= 0n) {
      const current = await this.findBySpaceId(validSpaceId);
      return current?.usedBytes ?? 0n;
    }

    const rows = await this.prisma.$queryRaw<Array<{ used_bytes: bigint }>>`
      WITH effective AS (
        SELECT COALESCE(
          (SELECT max_bytes FROM space_quotas WHERE space_id = ${validSpaceId}::uuid),
          ${DEFAULT_STORAGE_QUOTA_BYTES}::bigint
        ) AS max_bytes
      )
      INSERT INTO space_quotas (space_id, used_bytes, max_bytes, updated_at)
      SELECT ${validSpaceId}::uuid, ${bytes}::bigint, e.max_bytes, NOW()
      FROM effective e
      WHERE ${bytes}::bigint <= e.max_bytes
      ON CONFLICT (space_id) DO UPDATE
        SET used_bytes = space_quotas.used_bytes + EXCLUDED.used_bytes,
            updated_at = NOW()
      WHERE space_quotas.used_bytes + EXCLUDED.used_bytes <= space_quotas.max_bytes
      RETURNING used_bytes
    `;

    if (rows.length === 0) {
      throw new BadRequestException('Storage quota exceeded');
    }
    return BigInt(rows[0].used_bytes);
  }

  async decrementUsage(
    spaceId: string | null | undefined,
    bytes: bigint,
  ): Promise<bigint> {
    const validSpaceId = cleanUuid(spaceId);
    if (!validSpaceId) {
      return 0n;
    }

    if (bytes <= 0n) {
      const current = await this.findBySpaceId(validSpaceId);
      return current?.usedBytes ?? 0n;
    }

    const rows = await this.prisma.$queryRaw<Array<{ used_bytes: bigint }>>`
      UPDATE space_quotas
      SET used_bytes = GREATEST(0, used_bytes - ${bytes}::bigint),
          updated_at = NOW()
      WHERE space_id = ${validSpaceId}::uuid
      RETURNING used_bytes
    `;

    return rows.length > 0 ? BigInt(rows[0].used_bytes) : 0n;
  }

  async reconcileSpaceQuotas(limit = 200): Promise<number> {
    const affected = await this.prisma.$executeRaw`
      WITH computed AS (
        SELECT space_id, COALESCE(SUM(bytes), 0)::bigint AS actual_bytes
        FROM (
          SELECT space_id, size::bigint AS bytes
          FROM file_nodes
          WHERE is_folder = false AND blob_id IS NOT NULL
          UNION ALL
          SELECT space_id, size_bytes::bigint AS bytes
          FROM page_files
          WHERE deleted_at IS NULL AND blob_id IS NOT NULL
          UNION ALL
          SELECT li.space_id, att.size::bigint AS bytes
          FROM attachments att
          JOIN library_items li ON li.id = att.item_id
          WHERE att.file_id IS NOT NULL
            AND att.deleted_at IS NULL
            AND li.deleted_at IS NULL
          UNION ALL
          SELECT r.space_id, b.size_bytes::bigint AS bytes
          FROM file_blob_refs r
          JOIN file_blobs b ON b.id = r.blob_id
          WHERE r.owner_type NOT IN ('storage_file', 'page_file', 'attachment')
        ) usage_rows
        GROUP BY space_id
      ),
      targets AS (
        SELECT sq.space_id, LEAST(sq.max_bytes, GREATEST(0, COALESCE(c.actual_bytes, 0)))::bigint AS target_bytes
        FROM space_quotas sq
        LEFT JOIN computed c ON c.space_id = sq.space_id
        WHERE sq.used_bytes IS DISTINCT FROM LEAST(sq.max_bytes, GREATEST(0, COALESCE(c.actual_bytes, 0)))::bigint
        LIMIT ${limit}
      )
      UPDATE space_quotas sq
      SET used_bytes = t.target_bytes,
          updated_at = NOW()
      FROM targets t
      WHERE sq.space_id = t.space_id
    `;
    return Number(affected);
  }
}
