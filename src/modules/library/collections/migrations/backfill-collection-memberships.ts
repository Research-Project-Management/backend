import { PrismaClient } from '@prisma/client';

export interface BackfillCollectionMembershipsResult {
  totalEligible: number;
  itemsProcessed: number;
  membershipsCreated: number;
  alreadyExisting: number;
  errors: Array<{ itemId: string; collectionId: string; error: string }>;
  dryRun: boolean;
}

export async function runBackfillCollectionMemberships(
  prisma: PrismaClient,
  options: {
    batchSize?: number;
    dryRun?: boolean;
    workspaceId?: string;
  } = {},
): Promise<BackfillCollectionMembershipsResult> {
  const batchSize = options.batchSize ?? 50;
  const dryRun = options.dryRun ?? false;

  const whereClause: any = {
    collectionId: { not: null },
    deletedAt: null,
  };
  if (options.workspaceId) {
    whereClause.workspaceId = options.workspaceId;
  }

  const itemsWithCollection = await prisma.catalogItem.findMany({
    where: whereClause,
    select: {
      id: true,
      workspaceId: true,
      collectionId: true,
    },
  });

  const eligibleItems = itemsWithCollection.filter(
    (it) => it.collectionId && it.collectionId.trim() !== '',
  );

  const result: BackfillCollectionMembershipsResult = {
    totalEligible: eligibleItems.length,
    itemsProcessed: 0,
    membershipsCreated: 0,
    alreadyExisting: 0,
    errors: [],
    dryRun,
  };

  for (let i = 0; i < eligibleItems.length; i += batchSize) {
    const batch = eligibleItems.slice(i, i + batchSize);

    for (const item of batch) {
      const colId = item.collectionId!;
      try {
        const existingMembership = await prisma.collectionItem.findUnique({
          where: {
            collectionId_catalogItemId: {
              collectionId: colId,
              catalogItemId: item.id,
            },
          },
        });

        if (existingMembership) {
          result.alreadyExisting++;
          result.itemsProcessed++;
          continue;
        }

        if (!dryRun) {
          await prisma.collectionItem.create({
            data: {
              collectionId: colId,
              catalogItemId: item.id,
              sortOrder: 0,
              addedAt: new Date(),
            },
          });
        }

        result.membershipsCreated++;
        result.itemsProcessed++;
      } catch (err: any) {
        result.errors.push({
          itemId: item.id,
          collectionId: colId,
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
  console.log(`Starting Collection Membership Backfill (DryRun=${dryRun})...`);

  runBackfillCollectionMemberships(prisma, { dryRun })
    .then((res) => {
      console.log('Collection backfill finished with result:');
      console.log(JSON.stringify(res, null, 2));
      return prisma.$disconnect();
    })
    .catch((err) => {
      console.error('Collection backfill failed:', err);
      return prisma.$disconnect();
    });
}
