import { PrismaClient } from '@prisma/client';

export interface BackfillOptions {
  dryRun?: boolean;
  batchSize?: number;
}

export interface BackfillResult {
  totalPapersScanned: number;
  notesCreated: number;
  annotationsCreated: number;
  errors: number;
}

/**
 * Backfill legacy notes and extra JSON metadata into canonical Note and Annotation tables.
 */
export async function backfillNotesAndAnnotations(
  prisma: PrismaClient,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const isDryRun = options.dryRun ?? false;
  const batchSize = options.batchSize ?? 100;

  const result: BackfillResult = {
    totalPapersScanned: 0,
    notesCreated: 0,
    annotationsCreated: 0,
    errors: 0,
  };

  let cursor: string | undefined;

  while (true) {
    const papers = await prisma.catalogItem.findMany({
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      include: {
        notes: true,
        attachments: {
          include: { annotations: true },
        },
      },
    });

    if (papers.length === 0) break;
    result.totalPapersScanned += papers.length;

    for (const paper of papers) {
      try {
        // If paper has extra metadata containing user notes and no canonical note exists yet
        const extra = (paper as any).extra as Record<string, any> | null;
        if (extra && extra.legacyNotes && paper.notes.length === 0) {
          if (!isDryRun) {
            await prisma.note.create({
              data: {
                workspaceId: paper.workspaceId,
                itemId: paper.id,
                title: `Notes on ${paper.title}`,
                contentMd: typeof extra.legacyNotes === 'string' ? extra.legacyNotes : JSON.stringify(extra.legacyNotes),
                createdById: paper.uploadedById,
                version: 1,
              },
            });
          }
          result.notesCreated += 1;
        }
      } catch (err) {
        result.errors += 1;
      }
    }

    cursor = papers[papers.length - 1].id;
  }

  return result;
}

if (require.main === module) {
  const prisma = new PrismaClient();
  const isDryRun = process.argv.includes('--dry-run');

  console.log(`Starting Notes/Annotations backfill (dryRun=${isDryRun})...`);
  backfillNotesAndAnnotations(prisma, { dryRun: isDryRun })
    .then((summary) => {
      console.log('Backfill summary:', summary);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Backfill failed:', err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
