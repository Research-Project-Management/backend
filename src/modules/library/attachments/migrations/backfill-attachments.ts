// @ts-nocheck -- One-time historical backfill script; legacy columns dropped in 20260902000000_library_destructive_contraction
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';

export interface BackfillAttachmentsResult {
  totalEligible: number;
  itemsProcessed: number;
  attachmentsCreated: number;
  revisionsCreated: number;
  errors: Array<{ itemId: string; error: string }>;
  dryRun: boolean;
}

export function computeFileChecksum(
  url: string,
  filename: string,
  size: number,
): string {
  return createHash('sha256')
    .update(`${url}:${filename}:${size}`)
    .digest('hex');
}

export async function runBackfillAttachments(
  prisma: PrismaClient,
  options: {
    batchSize?: number;
    dryRun?: boolean;
    workspaceId?: string;
  } = {},
): Promise<BackfillAttachmentsResult> {
  const batchSize = options.batchSize ?? 50;
  const dryRun = options.dryRun ?? false;

  const whereClause: any = {
    deletedAt: null,
    fileUrl: { not: null },
  };
  if (options.workspaceId) {
    whereClause.workspaceId = options.workspaceId;
  }

  const allItems = await prisma.catalogItem.findMany({
    where: whereClause,
    select: {
      id: true,
      workspaceId: true,
      title: true,
      fileUrl: true,
      filename: true,
      mimeType: true,
      size: true,
      attachments: { select: { id: true, url: true, filename: true } },
    },
  });

  const eligibleItems = allItems.filter(
    (item) => item.fileUrl && item.fileUrl.trim() !== '',
  );

  const result: BackfillAttachmentsResult = {
    totalEligible: eligibleItems.length,
    itemsProcessed: 0,
    attachmentsCreated: 0,
    revisionsCreated: 0,
    errors: [],
    dryRun,
  };

  for (let i = 0; i < eligibleItems.length; i += batchSize) {
    const batch = eligibleItems.slice(i, i + batchSize);

    for (const item of batch) {
      try {
        const fileUrl = item.fileUrl!.trim();
        const filename = (item.filename || item.title || 'document.pdf').trim();
        const mimeType = item.mimeType || 'application/pdf';
        const size = item.size || 0;

        // Check if attachment already exists for this item
        const existing = item.attachments.find(
          (a) => a.url === fileUrl || a.filename === filename,
        );

        if (!existing) {
          const checksum = computeFileChecksum(fileUrl, filename, size);

          if (!dryRun) {
            const attachment = await prisma.catalogAttachment.create({
              data: {
                catalogItemId: item.id,
                filename,
                url: fileUrl,
                mimeType,
                size,
                fileHash: checksum,
                attachmentType: 'primary_pdf',
                revisions: {
                  create: {
                    revisionNumber: 1,
                    url: fileUrl,
                    fileHash: checksum,
                    sizeBytes: size,
                    comment: 'Backfilled from legacy catalog file',
                  },
                },
              },
            });
            result.attachmentsCreated++;
            result.revisionsCreated++;
          } else {
            result.attachmentsCreated++;
            result.revisionsCreated++;
          }
        }

        result.itemsProcessed++;
      } catch (err: any) {
        result.errors.push({
          itemId: item.id,
          error: err.message || String(err),
        });
      }
    }
  }

  return result;
}

// Standalone execution entrypoint
if (require.main === module) {
  const prisma = new PrismaClient();
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Starting Attachments Backfill (DryRun=${dryRun})...`);

  runBackfillAttachments(prisma, { dryRun })
    .then((res) => {
      console.log('Attachments backfill finished with result:');
      console.log(JSON.stringify(res, null, 2));
      return prisma.$disconnect();
    })
    .catch((err) => {
      console.error('Attachments backfill failed:', err);
      return prisma.$disconnect();
    });
}
