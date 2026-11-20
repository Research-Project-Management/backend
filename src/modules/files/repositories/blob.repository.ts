import { Injectable } from '@nestjs/common';
import { FileBlob as PrismaBlob } from '@prisma/client';
import { PrismaService } from '@/core';
import { ContentHash, StorageKey } from '../domain/storage-vo';
import {
  AttachBlobRefInput,
  BlobRefRecord,
  BlobStatus,
  StorageBlobRecord,
} from '../types/files.type';

export interface CreateBlobInput {
  id: string;
  contentHashHex: string;
  sizeBytes: bigint;
  mimeType: string;
  checksumVerified: boolean;
  s3Key: string;
  s3Bucket: string;
  hashAlgorithm?: string;
  storageClass?: string;
  status?: BlobStatus;
  refCount?: number;
}

@Injectable()
export class BlobRepository {
  constructor(private readonly prisma: PrismaService) {}

  private toBlobRecord(record: PrismaBlob): StorageBlobRecord {
    return {
      id: record.id,
      contentHashHex: Buffer.from(record.contentHash).toString('hex'),
      hashAlgorithm: record.hashAlgorithm,
      sizeBytes: record.sizeBytes,
      mimeType: record.mimeType || 'application/octet-stream',
      checksumVerified: Boolean(record.checksumVerified),
      s3Key: StorageKey.fromString(record.storageKey).value(),
      s3Bucket: record.bucket,
      storageClass: record.storageClass,
      refCount: record.refCount,
      status: record.status as BlobStatus,
      createdAt: record.createdAt,
      tombstoneAt: record.tombstoneAt,
      claimedAt: record.claimedAt ?? null,
    };
  }

  async findById(id: string): Promise<StorageBlobRecord | null> {
    const record = await this.prisma.fileBlob.findUnique({
      where: { id },
    });
    return record ? this.toBlobRecord(record) : null;
  }

  async findByHash(contentHashHex: string): Promise<StorageBlobRecord | null> {
    const hashBytes = ContentHash.fromHex(contentHashHex).toBytes();
    const record = await this.prisma.fileBlob.findUnique({
      where: {
        contentHash: Uint8Array.from(hashBytes),
      },
    });
    return record ? this.toBlobRecord(record) : null;
  }

  async create(input: CreateBlobInput): Promise<StorageBlobRecord> {
    const hashBytes = ContentHash.fromHex(input.contentHashHex).toBytes();
    const created = await this.prisma.fileBlob.create({
      data: {
        id: input.id,
        contentHash: Uint8Array.from(hashBytes),
        hashAlgorithm: input.hashAlgorithm ?? 'SHA256',
        sizeBytes: input.sizeBytes,
        mimeType: input.mimeType || 'application/octet-stream',
        checksumVerified: input.checksumVerified,
        storageKey: StorageKey.fromString(input.s3Key).value(),
        bucket: input.s3Bucket,
        storageClass: input.storageClass ?? 'STANDARD',
        refCount: input.refCount ?? 1,
        status: input.status ?? BlobStatus.READY,
      },
    });
    return this.toBlobRecord(created);
  }

  async delete(id: string): Promise<void> {
    await this.prisma.fileBlob.delete({
      where: { id },
    });
  }

  async deleteMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.fileBlob.deleteMany({
      where: { id: { in: ids } },
    });
  }

  async incrementRefCount(id: string): Promise<StorageBlobRecord | null> {
    const affected = await this.prisma.$executeRaw`
      UPDATE file_blobs
      SET
        ref_count = ref_count + 1,
        status = 'READY'::"BlobStatus",
        tombstone_at = NULL,
        claimed_at = NULL
      WHERE id = ${id}::uuid AND ref_count >= 0
    `;
    if (Number(affected) === 0) {
      return null;
    }
    return this.findById(id);
  }

  async decrementRefCount(
    id: string,
    tombstoneGraceHours = 48,
  ): Promise<StorageBlobRecord | null> {
    const tombstoneAt = new Date(
      Date.now() + tombstoneGraceHours * 3600 * 1000,
    );
    await this.prisma.$executeRaw`
      UPDATE file_blobs
      SET
        ref_count = GREATEST(0, ref_count - 1),
        status = CASE WHEN ref_count - 1 <= 0 THEN 'DELETED'::"BlobStatus" ELSE status END,
        tombstone_at = CASE WHEN ref_count - 1 <= 0 THEN ${tombstoneAt} ELSE tombstone_at END
      WHERE id = ${id}::uuid
    `;
    return this.findById(id);
  }

  async reclaimStuckClaims(staleBefore: Date): Promise<number> {
    const affected = await this.prisma.$executeRaw`
      UPDATE file_blobs
      SET ref_count = 0, claimed_at = NULL
      WHERE ref_count = -1 AND claimed_at < ${staleBefore}
    `;
    return Number(affected);
  }

  async claimOrphanBlobsBatch(
    threshold: Date,
    limit: number,
  ): Promise<StorageBlobRecord[]> {
    const rows = await this.prisma.$queryRaw<PrismaBlob[]>`
      WITH candidates AS (
        SELECT b.id
        FROM file_blobs b
        WHERE b.ref_count = 0
          AND b.status = 'DELETED'::"BlobStatus"
          AND b.tombstone_at < ${threshold}
          AND NOT EXISTS (SELECT 1 FROM file_blob_refs sbr WHERE sbr.blob_id = b.id)
          AND NOT EXISTS (SELECT 1 FROM file_nodes sf WHERE sf.blob_id = b.id)
          AND NOT EXISTS (SELECT 1 FROM file_versions sv WHERE sv.blob_id = b.id)
          AND NOT EXISTS (SELECT 1 FROM page_files pf WHERE pf.blob_id = b.id)
          AND NOT EXISTS (SELECT 1 FROM attachments att WHERE att.file_id = b.id)
          AND NOT EXISTS (SELECT 1 FROM attachment_revisions ar WHERE ar.file_id = b.id)
          AND NOT EXISTS (SELECT 1 FROM annotations an WHERE an.image_file_id = b.id)
          AND NOT EXISTS (SELECT 1 FROM attachment_structures ast WHERE ast.fulltext_file_id = b.id)
        ORDER BY b.tombstone_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE file_blobs b
      SET ref_count = -1, claimed_at = NOW()
      FROM candidates c
      WHERE b.id = c.id
      RETURNING
        b.id,
        b.content_hash AS "contentHash",
        b.hash_algorithm AS "hashAlgorithm",
        b.size_bytes AS "sizeBytes",
        b.mime_type AS "mimeType",
        b.checksum_verified AS "checksumVerified",
        b.storage_key AS "storageKey",
        b.bucket AS "bucket",
        b.storage_class AS "storageClass",
        b.ref_count AS "refCount",
        b.status,
        b.created_at AS "createdAt",
        b.tombstone_at AS "tombstoneAt",
        b.claimed_at AS "claimedAt"
    `;
    return rows.map((r) => this.toBlobRecord(r));
  }

  async restoreClaimedBlob(id: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE file_blobs
      SET ref_count = 0, claimed_at = NULL
      WHERE id = ${id}::uuid AND ref_count = -1
    `;
  }

  async hasSpaceAccessToBlob(
    blobId: string,
    spaceId: string,
  ): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<
      Array<{ exists_in_space: boolean }>
    >`
      SELECT EXISTS (
        SELECT 1 FROM file_blob_refs sbr
        WHERE sbr.blob_id = ${blobId}::uuid AND sbr.space_id = ${spaceId}::uuid
        UNION ALL
        SELECT 1 FROM file_nodes sf
        WHERE sf.blob_id = ${blobId}::uuid AND sf.space_id = ${spaceId}::uuid AND sf.deleted_at IS NULL
        UNION ALL
        SELECT 1 FROM file_versions sv
        JOIN file_nodes sf ON sf.id = sv.file_id
        WHERE sv.blob_id = ${blobId}::uuid AND sf.space_id = ${spaceId}::uuid AND sf.deleted_at IS NULL
        UNION ALL
        SELECT 1 FROM page_files pf
        WHERE pf.blob_id = ${blobId}::uuid AND pf.space_id = ${spaceId}::uuid AND pf.deleted_at IS NULL
        UNION ALL
        SELECT 1 FROM attachments att
        JOIN library_items li ON li.id = att.item_id
        WHERE att.file_id = ${blobId}::uuid AND li.space_id = ${spaceId}::uuid AND att.deleted_at IS NULL AND li.deleted_at IS NULL
      ) AS exists_in_space
    `;
    return Boolean(rows[0]?.exists_in_space);
  }

  async hasUserAccessToSpace(
    userId: string,
    spaceId: string,
  ): Promise<boolean> {
    const space = await this.prisma.space.findUnique({
      where: { id: spaceId },
      select: {
        id: true,
        type: true,
        ownerUserId: true,
        project: {
          select: {
            createdById: true,
            members: {
              where: { userId },
              select: { role: true },
              take: 1,
            },
          },
        },
      },
    });

    if (!space) {
      return false;
    }

    if (space.type === 'personal') {
      return space.ownerUserId === userId;
    }

    const projectRecord = space.project;
    return Boolean(
      projectRecord &&
      (projectRecord.createdById === userId ||
        projectRecord.members.length > 0),
    );
  }

  async hasUserAccessToBlob(userId: string, blobId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ allowed: boolean }>>`
      WITH accessible_spaces AS (
        SELECT s.id
        FROM spaces s
        LEFT JOIN projects p ON p.id = s.project_id
        WHERE s.owner_user_id = ${userId}::uuid
           OR s.id = ${userId}::uuid
           OR p.created_by_id = ${userId}::uuid
           OR EXISTS (
             SELECT 1 FROM project_members pm
             WHERE pm.project_id = s.project_id
               AND pm.user_id = ${userId}::uuid
           )
      )
      SELECT EXISTS (
        SELECT 1 FROM file_blob_refs r
        JOIN accessible_spaces sp ON sp.id = r.space_id
        WHERE r.blob_id = ${blobId}::uuid
        UNION ALL
        SELECT 1 FROM file_nodes sf
        JOIN accessible_spaces sp ON sp.id = sf.space_id
        WHERE sf.blob_id = ${blobId}::uuid
          AND sf.deleted_at IS NULL
        UNION ALL
        SELECT 1 FROM file_versions sv
        JOIN file_nodes sf ON sf.id = sv.file_id
        JOIN accessible_spaces sp ON sp.id = sf.space_id
        WHERE sv.blob_id = ${blobId}::uuid
          AND sf.deleted_at IS NULL
        UNION ALL
        SELECT 1 FROM page_files pf
        JOIN pages pg ON pg.id = pf.page_id
        JOIN accessible_spaces sp ON sp.id = pg.space_id
        WHERE pf.blob_id = ${blobId}::uuid
          AND pf.deleted_at IS NULL
          AND pg.deleted_at IS NULL
        UNION ALL
        SELECT 1 FROM attachments att
        JOIN library_items li ON li.id = att.item_id
        JOIN accessible_spaces sp ON sp.id = li.space_id
        WHERE att.file_id = ${blobId}::uuid
          AND att.deleted_at IS NULL
          AND li.deleted_at IS NULL
      ) AS allowed
    `;

    return Boolean(rows[0]?.allowed);
  }

  async attachRef(
    input: AttachBlobRefInput,
  ): Promise<{ created: boolean; ref: BlobRefRecord }> {
    const inserted = await this.prisma.$queryRaw<BlobRefRecord[]>`
      WITH ins AS (
        INSERT INTO file_blob_refs (owner_type, owner_id, blob_id, space_id, created_at)
        VALUES (
          ${input.ownerType},
          ${input.ownerId},
          ${input.blobId}::uuid,
          ${input.spaceId}::uuid,
          NOW()
        )
        ON CONFLICT (owner_type, owner_id) DO NOTHING
        RETURNING blob_id, space_id, owner_type, owner_id, created_at
      )
      SELECT
        ins.blob_id AS "blobId",
        ins.space_id AS "spaceId",
        ins.owner_type AS "ownerType",
        ins.owner_id AS "ownerId",
        b.size_bytes AS "sizeBytes",
        ins.created_at AS "createdAt"
      FROM ins
      JOIN file_blobs b ON b.id = ins.blob_id
    `;

    if (inserted.length > 0) {
      return { created: true, ref: inserted[0] };
    }

    const existing = await this.prisma.fileBlobRef.findUnique({
      where: {
        ownerType_ownerId: {
          ownerType: input.ownerType,
          ownerId: input.ownerId,
        },
      },
      include: {
        blob: {
          select: { sizeBytes: true },
        },
      },
    });
    if (!existing) {
      throw new Error(
        `Failed to resolve file_blob_ref for ${input.ownerType}:${input.ownerId}`,
      );
    }
    return {
      created: false,
      ref: {
        blobId: existing.blobId,
        spaceId: existing.spaceId,
        ownerType: existing.ownerType,
        ownerId: existing.ownerId,
        sizeBytes: existing.blob.sizeBytes,
        createdAt: existing.createdAt,
      },
    };
  }

  async detachRef(
    ownerType: string,
    ownerId: string,
  ): Promise<BlobRefRecord | null> {
    const deleted = await this.prisma.$queryRaw<BlobRefRecord[]>`
      WITH del AS (
        DELETE FROM file_blob_refs
        WHERE owner_type = ${ownerType}
          AND owner_id = ${ownerId}
        RETURNING blob_id, space_id, owner_type, owner_id, created_at
      )
      SELECT
        del.blob_id AS "blobId",
        del.space_id AS "spaceId",
        del.owner_type AS "ownerType",
        del.owner_id AS "ownerId",
        b.size_bytes AS "sizeBytes",
        del.created_at AS "createdAt"
      FROM del
      JOIN file_blobs b ON b.id = del.blob_id
    `;
    return deleted[0] ?? null;
  }

  async existsInSpace(blobId: string, spaceId: string): Promise<boolean> {
    const row = await this.prisma.fileBlobRef.findFirst({
      where: { blobId, spaceId },
      select: { ownerId: true },
    });
    return row !== null;
  }

  async findByStorageKey(
    storageKey: string,
  ): Promise<StorageBlobRecord | null> {
    const normalizedKey = StorageKey.fromString(storageKey).value();
    const record = await this.prisma.fileBlob.findFirst({
      where: { storageKey: normalizedKey },
    });
    return record ? this.toBlobRecord(record) : null;
  }

  async existsByStorageKey(storageKey: string): Promise<boolean> {
    const normalizedKey = StorageKey.fromString(storageKey).value();
    const row = await this.prisma.fileBlob.findFirst({
      where: { storageKey: normalizedKey },
      select: { id: true },
    });
    return row !== null;
  }

  async promoteStorageLocation(input: {
    blobId: string;
    expectedCurrentKey: string;
    nextStorageKey: string;
    nextContentHashHex?: string;
    checksumVerified: boolean;
  }): Promise<boolean> {
    const expectedCurrentKey = StorageKey.fromString(
      input.expectedCurrentKey,
    ).value();
    const nextStorageKey = StorageKey.fromString(input.nextStorageKey).value();

    const res = await this.prisma.fileBlob.updateMany({
      where: {
        id: input.blobId,
        storageKey: expectedCurrentKey,
      },
      data: {
        storageKey: nextStorageKey,
        checksumVerified: input.checksumVerified,
        ...(input.nextContentHashHex
          ? {
              contentHash: Uint8Array.from(
                ContentHash.fromHex(input.nextContentHashHex).toBytes(),
              ),
            }
          : {}),
      },
    });
    return res.count > 0;
  }

  async findUnpromotedStagingBlobs(
    olderThan: Date,
    limit: number,
  ): Promise<StorageBlobRecord[]> {
    const records = await this.prisma.fileBlob.findMany({
      where: {
        status: BlobStatus.READY,
        storageKey: { startsWith: 'uploads/staging/' },
        createdAt: { lt: olderThan },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return records.map((r) => this.toBlobRecord(r));
  }
}
