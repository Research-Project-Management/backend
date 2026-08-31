import { PrismaClient } from '@prisma/client';

export interface BackfillTagsResult {
  totalEligible: number;
  itemsProcessed: number;
  tagsCreated: number;
  itemTagsCreated: number;
  errors: Array<{ itemId: string; error: string }>;
  dryRun: boolean;
}

export function normalizeTagName(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, ' ')
    .trim();
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

  const eligibleItems = allItems.filter(
    (item) =>
      (Array.isArray(item.labels) && item.labels.length > 0) ||
      (Array.isArray(item.keywords) && item.keywords.length > 0),
  );

  const result: BackfillTagsResult = {
    totalEligible: eligibleItems.length,
    itemsProcessed: 0,
    tagsCreated: 0,
    itemTagsCreated: 0,
    errors: [],
    dryRun,
  };

  for (let i = 0; i < eligibleItems.length; i += batchSize) {
    const batch = eligibleItems.slice(i, i + batchSize);

    for (const item of batch) {
      try {
        const rawTagSet = new Set<string>();
        if (Array.isArray(item.labels)) {
          item.labels.forEach((l) => {
            if (typeof l === 'string' && l.trim()) rawTagSet.add(normalizeTagName(l));
          });
        }
        if (Array.isArray(item.keywords)) {
          item.keywords.forEach((k) => {
            if (typeof k === 'string' && k.trim()) rawTagSet.add(normalizeTagName(k));
          });
        }

        const normalizedTags = Array.from(rawTagSet).filter(Boolean);

        if (normalizedTags.length === 0) {
          result.itemsProcessed++;
          continue;
        }

        if (!dryRun) {
          for (const tagName of normalizedTags) {
            // Find or create tag
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

            // Link tag to item
            const existingLink = await prisma.catalogItemTag.findUnique({
              where: {
                tagId_catalogItemId: {
                  tagId: tag.id,
                  catalogItemId: item.id,
                },
              },
            });

            if (!existingLink) {
              await prisma.catalogItemTag.create({
                data: {
                  tagId: tag.id,
                  catalogItemId: item.id,
                },
              });
              result.itemTagsCreated++;
            }
          }
        } else {
          result.tagsCreated += normalizedTags.length;
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
