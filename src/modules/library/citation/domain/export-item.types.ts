import { Prisma } from '@prisma/client';

/** Maximum number of items exported in a single request. */
export const EXPORT_MAX_ITEMS = 1000;
/** Cursor-page size used when fetching from the DB. */
export const EXPORT_CHUNK_SIZE = 200;

export type ExportItemRecord = Prisma.ItemGetPayload<{
  include: {
    contributors: { orderBy: { orderIndex: 'asc' } };
    itemTags?: { include: { tag: true } };
    notesList?: { where: { deletedAt: null } };
    identifiers?: true;
  };
}>;
