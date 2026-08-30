import { PrismaService } from '../../../../core/database/prisma.service';
import { normalizeDoi } from '../policies/ingestion.policy';
import { IngestionValidationException } from '../errors/ingestion.errors';
import { MetadataPort } from '../metadata/types/metadata.types';

export interface PreparedDoiItem {
  deduplicated: boolean;
  existingItem?: any;
  normalizedDoi: string;
  itemData?: {
    title: string;
    doi: string;
    abstract?: string;
    authors?: string[];
    creators?: any[];
    year?: number | null;
    publicationTitle?: string;
    journal?: string;
    publisher?: string;
    volume?: string;
    issue?: string;
    pages?: string;
    url?: string;
    itemType?: string;
    keywords?: string[];
    issn?: string;
    isbn?: string;
  };
}

export async function prepareDoiIngestion(
  workspaceId: string,
  rawDoi: string,
  prisma: PrismaService,
  metadataService?: MetadataPort,
): Promise<PreparedDoiItem> {
  const normalizedDoi = normalizeDoi(rawDoi);
  if (!normalizedDoi) {
    throw new IngestionValidationException('A valid DOI must be provided');
  }

  // 1. Database-backed deduplication claim check within workspace
  if (prisma.libraryDedupClaim?.findUnique) {
    const claim = await prisma.libraryDedupClaim.findUnique({
      where: {
        workspaceId_claimType_claimValue: {
          workspaceId,
          claimType: 'doi',
          claimValue: normalizedDoi,
        },
      },
      include: {
        catalogItem: {
          include: { attachments: true, contributors: true },
        },
      },
    });

    if (claim?.catalogItem && !claim.catalogItem.deletedAt) {
      return {
        deduplicated: true,
        existingItem: claim.catalogItem,
        normalizedDoi,
      };
    }
  }

  // Fallback check on CatalogItem.doi
  let existing: any = null;
  if (prisma.catalogItem?.findFirst) {
    existing = await prisma.catalogItem.findFirst({
      where: {
        workspaceId,
        doi: normalizedDoi,
        deletedAt: null,
      },
      include: { attachments: true, contributors: true },
    });
  }

  if (existing) {
    return {
      deduplicated: true,
      existingItem: existing,
      normalizedDoi,
    };
  }

  // 2. Metadata resolution outside transaction
  let meta: any = null;
  if (metadataService) {
    try {
      const res = await metadataService.resolve({
        query: normalizedDoi,
        workspaceId,
      });
      meta = res?.metadata || null;
    } catch {
      meta = null;
    }
  }

  const authors: string[] = (meta?.creators || meta?.authors || [])
    .map((c: any) =>
      typeof c === 'string'
        ? c
        : c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
    )
    .filter(Boolean);

  const creators = (meta?.creators || meta?.authors || []).map(
    (c: any, index: number) => ({
      creatorType: c.creatorType || 'author',
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      fullName:
        typeof c === 'string'
          ? c
          : c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
      orderIndex: index,
    }),
  );

  const itemData = {
    title: meta?.title || `Paper (${normalizedDoi})`,
    doi: normalizedDoi,
    abstract: meta?.abstract || '',
    authors: authors.length > 0 ? authors : undefined,
    creators: creators.length > 0 ? creators : undefined,
    year: meta?.year ? parseInt(String(meta.year), 10) : null,
    publicationTitle: meta?.publicationTitle || meta?.journal || '',
    journal: meta?.journal || meta?.publicationTitle || '',
    publisher: meta?.publisher || '',
    volume: meta?.volume || '',
    issue: meta?.issue || '',
    pages: meta?.pages || '',
    url: meta?.url || `https://doi.org/${normalizedDoi}`,
    itemType: meta?.itemType || 'journalArticle',
    keywords: meta?.keywords || [],
    issn: meta?.issn || '',
    isbn: meta?.isbn || '',
  };

  return {
    deduplicated: false,
    normalizedDoi,
    itemData,
  };
}
