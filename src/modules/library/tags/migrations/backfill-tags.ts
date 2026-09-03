// @ts-nocheck -- One-time historical backfill script; legacy columns dropped in 20260902000000_library_destructive_contraction
import { PrismaClient } from '@prisma/client';
import { normalizeTags } from '../utils/tags.utils';

export interface BackfillTagsResult {
  totalEligible: number;
  itemsProcessed: number;
  tagsCreated: number;
  itemTagsCreated: number;
  alreadyExisting: number;
  errors: Array<{ itemId: string; error: string }>;
  dryRun: boolean;
}

export async function runBackfillTags(
  prisma: PrismaClient,
  options: {
    batchSize?: number;
    dryRun?: boolean;
    workspaceId?: string;
  } = {},
): Promise<BackfillTagsResult> {
  const batchSize = options.batchSize ?? 50;
  const dryRun = options.dryRun ?? false;

  const whereClause: any = {
    deletedAt: null,
    OR: [{ labels: { isEmpty: false } }, { keywords: { isEmpty: false } }],
  };
  if (options.workspaceId) {
    whereClause.workspaceId = options.workspaceId;
  }

  const allItems = await prisma.catalogItem.findMany({
    where: whereClause,
    select: {
      id: true,
      workspaceId: true,
      labels: true,
      keywords: true,
      itemTags: { select: { tagId: true } },
    },
  });

  const eligibleItems = allItems.filter((item) => {
    const raw = [
      ...(Array.isArray(item.labels) ? item.labels : []),
      ...(Array.isArray(item.keywords) ? item.keywords : []),
    ];
    return raw.length > 0;
  });

  const result: BackfillTagsResult = {
    totalEligible: eligibleItems.length,
    itemsProcessed: 0,
    tagsCreated: 0,
    itemTagsCreated: 0,
    alreadyExisting: 0,
    errors: [],
    dryRun,
  };

  for (let i = 0; i < eligibleItems.length; i += batchSize) {
    const batch = eligibleItems.slice(i, i + batchSize);

    for (const item of batch) {
      try {
        const rawTags = [
          ...(Array.isArray(item.labels) ? item.labels : []),
          ...(Array.isArray(item.keywords) ? item.keywords : []),
        ];
        const normalizedTags = normalizeTags(rawTags);

        if (normalizedTags.length === 0) {
          result.itemsProcessed++;
          continue;
        }

        const existingTagIds = new Set(
          item.itemTags?.map((it) => it.tagId) || [],
        );

        if (!dryRun) {
          for (const tagName of normalizedTags) {
            // Find or create CatalogTag scoped to workspace
            let tag = await prisma.catalogTag.findUnique({
              where: {
                workspaceId_name: {
                  workspaceId: item.workspaceId,
                  name: tagName,
                },
              },
            });

            if (!tag) {
              tag = await prisma.catalogTag.create({
                data: {
                  workspaceId: item.workspaceId,
                  name: tagName,
                  color: '#3b82f6',
                  type: 'manual',
                },
              });
              result.tagsCreated++;
            }

            // Check if already linked
            if (existingTagIds.has(tag.id)) {
              result.alreadyExisting++;
              continue;
            }

            // Create join relation
            await prisma.catalogItemTag.upsert({
              where: {
                tagId_catalogItemId: {
                  tagId: tag.id,
                  catalogItemId: item.id,
                },
              },
              create: {
                tagId: tag.id,
                catalogItemId: item.id,
              },
              update: {},
            });

            existingTagIds.add(tag.id);
            result.itemTagsCreated++;
          }
        } else {
          result.itemTagsCreated += normalizedTags.length;
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
  console.log(`Starting Tags Backfill (DryRun=${dryRun})...`);

  runBackfillTags(prisma, { dryRun })
    .then((res) => {
      console.log('Tags backfill finished with result:');
      console.log(JSON.stringify(res, null, 2));
      return prisma.$disconnect();
    })
    .catch((err) => {
      console.error('Tags backfill failed:', err);
      return prisma.$disconnect();
    });
}
