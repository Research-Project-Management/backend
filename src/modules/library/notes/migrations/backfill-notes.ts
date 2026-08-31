import { PrismaClient } from '@prisma/client';

export interface BackfillNotesResult {
  totalEligible: number;
  itemsProcessed: number;
  notesCreated: number;
  errors: Array<{ itemId: string; error: string }>;
  dryRun: boolean;
}

export interface ExtractedNoteContent {
  title: string;
  contentMd: string;
  contentJson?: any;
}

export function extractNotePayloads(rawNotes: any): ExtractedNoteContent[] {
  if (!rawNotes) return [];

  const results: ExtractedNoteContent[] = [];

  if (typeof rawNotes === 'string') {
    const trimmed = rawNotes.trim();
    if (trimmed) {
      results.push({
        title: 'Imported Note',
        contentMd: trimmed,
      });
    }
    return results;
  }

  if (Array.isArray(rawNotes)) {
    for (let idx = 0; idx < rawNotes.length; idx++) {
      const entry = rawNotes[idx];
      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (trimmed) {
          results.push({
            title: `Note ${idx + 1}`,
            contentMd: trimmed,
          });
        }
      } else if (entry && typeof entry === 'object') {
        const contentStr =
          typeof entry.content === 'string'
            ? entry.content
            : typeof entry.text === 'string'
              ? entry.text
              : typeof entry.note === 'string'
                ? entry.note
                : typeof entry.body === 'string'
                  ? entry.body
                  : '';

        const titleStr =
          typeof entry.title === 'string' && entry.title.trim()
            ? entry.title.trim()
            : `Note ${idx + 1}`;

        if (contentStr.trim() || entry.contentJson || entry.type === 'doc') {
          results.push({
            title: titleStr,
            contentMd: contentStr.trim(),
            contentJson: entry.contentJson || (entry.type === 'doc' ? entry : undefined),
          });
        }
      }
    }
    return results;
  }

  if (typeof rawNotes === 'object') {
    if (rawNotes.type === 'doc') {
      results.push({
        title: 'Document Note',
        contentMd: '',
        contentJson: rawNotes,
      });
    } else {
      const contentStr =
        typeof rawNotes.content === 'string'
          ? rawNotes.content
          : typeof rawNotes.text === 'string'
            ? rawNotes.text
            : typeof rawNotes.note === 'string'
              ? rawNotes.note
              : '';
      const titleStr =
        typeof rawNotes.title === 'string' && rawNotes.title.trim()
          ? rawNotes.title.trim()
          : 'Imported Note';

      if (contentStr.trim()) {
        results.push({
          title: titleStr,
          contentMd: contentStr.trim(),
          contentJson: rawNotes.contentJson,
        });
      }
    }
  }

  return results;
}

export async function runBackfillNotes(
  prisma: PrismaClient,
  options: {
    batchSize?: number;
    dryRun?: boolean;
    workspaceId?: string;
  } = {},
): Promise<BackfillNotesResult> {
  const batchSize = options.batchSize ?? 50;
  const dryRun = options.dryRun ?? false;

  const whereClause: any = {
    deletedAt: null,
    notes: { not: null },
  };
  if (options.workspaceId) {
    whereClause.workspaceId = options.workspaceId;
  }

  const allItems = await prisma.catalogItem.findMany({
    where: whereClause,
    select: {
      id: true,
      workspaceId: true,
      notes: true,
      uploadedById: true,
      workspace: { select: { createdById: true } },
      notesList: { select: { id: true, contentMd: true } },
    },
  });

  const eligibleItems = allItems.filter((item) => {
    if (!item.notes) return false;
    if (Array.isArray(item.notes) && item.notes.length === 0) return false;
    if (typeof item.notes === 'string' && item.notes.trim() === '') return false;
    return true;
  });

  const result: BackfillNotesResult = {
    totalEligible: eligibleItems.length,
    itemsProcessed: 0,
    notesCreated: 0,
    errors: [],
    dryRun,
  };

  for (let i = 0; i < eligibleItems.length; i += batchSize) {
    const batch = eligibleItems.slice(i, i + batchSize);

    for (const item of batch) {
      try {
        const extracted = extractNotePayloads(item.notes);
        if (extracted.length === 0) {
          result.itemsProcessed++;
          continue;
        }

        const authorId =
          item.uploadedById || item.workspace.createdById || 'system';

        if (!dryRun) {
          for (const noteData of extracted) {
            // Check if identical note already exists for this item
            const existing = await prisma.note.findFirst({
              where: {
                workspaceId: item.workspaceId,
                itemId: item.id,
                contentMd: noteData.contentMd,
                deletedAt: null,
              },
            });

            if (!existing) {
              await prisma.note.create({
                data: {
                  workspaceId: item.workspaceId,
                  itemId: item.id,
                  title: noteData.title,
                  contentMd: noteData.contentMd,
                  contentJson: noteData.contentJson ?? undefined,
                  createdById: authorId,
                },
              });
              result.notesCreated++;
            }
          }
        } else {
          result.notesCreated += extracted.length;
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
  console.log(`Starting Notes Backfill (DryRun=${dryRun})...`);

  runBackfillNotes(prisma, { dryRun })
    .then((res) => {
      console.log('Notes backfill finished with result:');
      console.log(JSON.stringify(res, null, 2));
      return prisma.$disconnect();
    })
    .catch((err) => {
      console.error('Notes backfill failed:', err);
      return prisma.$disconnect();
    });
}
