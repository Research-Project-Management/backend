import { PrismaClient } from '@prisma/client';
import { CreatorType } from '../types/creator.types';

export interface ParsedCreator {
  orderIndex: number;
  creatorType: CreatorType;
  firstName: string;
  lastName: string;
  fullName: string;
}

const INSTITUTION_KEYWORDS = [
  'organization',
  'organisation',
  'association',
  'institute',
  'institution',
  'university',
  'laboratory',
  'collab',
  'collaboration',
  'group',
  'team',
  'consortium',
  'network',
  'department',
  'agency',
  'center',
  'centre',
  'foundation',
  'corporation',
  'inc',
  'llc',
  'ltd',
  'openai',
  'google',
  'microsoft',
  'meta',
  'deepmind',
];

export function parseCreatorString(
  rawName: string,
  orderIndex: number = 0,
  creatorType: CreatorType = 'author',
): ParsedCreator {
  const trimmed = rawName.trim().replace(/\s+/g, ' ');

  if (!trimmed) {
    return {
      orderIndex,
      creatorType,
      firstName: '',
      lastName: '',
      fullName: 'Unknown',
    };
  }

  const lower = trimmed.toLowerCase();
  const isInstitution = INSTITUTION_KEYWORDS.some((kw) =>
    new RegExp(`\\b${kw}\\b`, 'i').test(lower),
  );

  if (isInstitution) {
    return {
      orderIndex,
      creatorType,
      firstName: '',
      lastName: '',
      fullName: trimmed,
    };
  }

  // Comma separated: "LastName, FirstName MiddleName"
  if (trimmed.includes(',')) {
    const parts = trimmed.split(',').map((p) => p.trim());
    const lastName = parts[0] || '';
    const firstName = parts.slice(1).join(' ') || '';
    const fullName = firstName ? `${firstName} ${lastName}` : lastName;
    return {
      orderIndex,
      creatorType,
      firstName,
      lastName,
      fullName,
    };
  }

  // Space separated: "FirstName [MiddleName...] LastName"
  const tokens = trimmed.split(' ');
  if (tokens.length === 1) {
    // Single word name / mononym (e.g. "Plato", "Aristotle")
    return {
      orderIndex,
      creatorType,
      firstName: '',
      lastName: tokens[0],
      fullName: tokens[0],
    };
  }

  // Check if it might be an East Asian / Vietnamese name (3-4 words common pattern)
  // Default decomposition: First token is firstName (or family name), last token is lastName
  const lastName = tokens[tokens.length - 1];
  const firstName = tokens.slice(0, -1).join(' ');

  return {
    orderIndex,
    creatorType,
    firstName,
    lastName,
    fullName: trimmed,
  };
}

export interface BackfillCreatorsResult {
  totalEligible: number;
  itemsProcessed: number;
  contributorsCreated: number;
  identifiersCreated: number;
  errors: Array<{ itemId: string; error: string }>;
  dryRun: boolean;
}

export async function runBackfillCreators(
  prisma: PrismaClient,
  options: {
    batchSize?: number;
    dryRun?: boolean;
    workspaceId?: string;
  } = {},
): Promise<BackfillCreatorsResult> {
  const batchSize = options.batchSize ?? 50;
  const dryRun = options.dryRun ?? false;

  const whereClause: any = {
    deletedAt: null,
  };
  if (options.workspaceId) {
    whereClause.workspaceId = options.workspaceId;
  }

  // Find all items with authors array or doi that need backfill
  const eligibleItems = await prisma.catalogItem.findMany({
    where: whereClause,
    select: {
      id: true,
      workspaceId: true,
      authors: true,
      doi: true,
      contributors: { select: { id: true } },
      identifiers: { select: { id: true, type: true } },
    },
  });

  const itemsNeedingBackfill = eligibleItems.filter(
    (item) =>
      (Array.isArray(item.authors) &&
        item.authors.length > 0 &&
        item.contributors.length === 0) ||
      (item.doi &&
        item.doi.trim() !== '' &&
        !item.identifiers.some((i) => i.type === 'doi')),
  );

  const result: BackfillCreatorsResult = {
    totalEligible: itemsNeedingBackfill.length,
    itemsProcessed: 0,
    contributorsCreated: 0,
    identifiersCreated: 0,
    errors: [],
    dryRun,
  };

  // Process in bounded batches
  for (let i = 0; i < itemsNeedingBackfill.length; i += batchSize) {
    const batch = itemsNeedingBackfill.slice(i, i + batchSize);

    for (const item of batch) {
      try {
        const contributorsToCreate: ParsedCreator[] = [];
        if (
          Array.isArray(item.authors) &&
          item.authors.length > 0 &&
          item.contributors.length === 0
        ) {
          item.authors.forEach((rawAuthor, idx) => {
            if (rawAuthor && typeof rawAuthor === 'string') {
              contributorsToCreate.push(parseCreatorString(rawAuthor, idx));
            }
          });
        }

        const doiToCreate =
          item.doi &&
          item.doi.trim() !== '' &&
          !item.identifiers.some((ident) => ident.type === 'doi')
            ? item.doi.trim()
            : null;

        if (!dryRun) {
          await prisma.$transaction(async (tx) => {
            if (contributorsToCreate.length > 0) {
              await tx.catalogContributor.createMany({
                data: contributorsToCreate.map((c) => ({
                  catalogItemId: item.id,
                  creatorType: c.creatorType,
                  firstName: c.firstName,
                  lastName: c.lastName,
                  fullName: c.fullName,
                  orderIndex: c.orderIndex,
                })),
              });
            }

            if (doiToCreate) {
              await tx.catalogIdentifier.create({
                data: {
                  catalogItemId: item.id,
                  type: 'doi',
                  value: doiToCreate,
                  canonicalUri: `https://doi.org/${doiToCreate}`,
                },
              });
            }
          });
        }

        result.itemsProcessed++;
        result.contributorsCreated += contributorsToCreate.length;
        if (doiToCreate) {
          result.identifiersCreated++;
        }
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
  console.log(`Starting Catalog Creators & Identifiers Backfill (DryRun=${dryRun})...`);

  runBackfillCreators(prisma, { dryRun })
    .then((res) => {
      console.log('Backfill finished with result:');
      console.log(JSON.stringify(res, null, 2));
      return prisma.$disconnect();
    })
    .catch((err) => {
      console.error('Backfill failed:', err);
      return prisma.$disconnect();
    });
}
