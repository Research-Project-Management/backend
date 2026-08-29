import { PrismaService } from '../../../../core/database/prisma.service';
import { INGESTION_LIMITS, normalizeDoi } from '../policies/ingestion.policy';
import { IngestionValidationException } from '../errors/ingestion.errors';
import { BibtexParser } from '../../citation/formatters/bibtex.parser';
import { ICanonicalMetadataService } from '../metadata/metadata.contracts';

export interface PreparedBibtexItem {
  deduplicated: boolean;
  existingItem?: any;
  itemData?: {
    title: string;
    doi?: string;
    citationKey?: string;
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
    extra?: string;
  };
}

export async function prepareBibtexIngestion(
  workspaceId: string,
  content: string,
  prisma: PrismaService,
  bibtexParser: BibtexParser,
  metadataService?: ICanonicalMetadataService,
): Promise<PreparedBibtexItem> {
  if (!content || !content.trim()) {
    throw new IngestionValidationException('BibTeX content cannot be empty');
  }

  if (
    Buffer.byteLength(content, 'utf-8') > INGESTION_LIMITS.MAX_BIBTEX_SIZE_BYTES
  ) {
    throw new IngestionValidationException(
      `BibTeX content exceeds ${INGESTION_LIMITS.MAX_BIBTEX_SIZE_BYTES / (1024 * 1024)}MB limit`,
    );
  }

  const entries = bibtexParser.parse(content);
  if (!entries || entries.length === 0) {
    throw new IngestionValidationException(
      'No valid BibTeX entries found in payload',
    );
  }

  const primary = entries[0];
  const normalizedDoi = normalizeDoi(primary.doi);

  // 1. If DOI is present in BibTeX entry, check deduplication in workspace
  if (normalizedDoi) {
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
      };
    }
  }

  // 2. Optional enrichment if DOI present
  let enriched: any = null;
  if (normalizedDoi && metadataService) {
    try {
      const res = await metadataService.resolve({
        query: normalizedDoi,
        workspaceId,
      });
      enriched = res?.metadata || null;
    } catch {
      enriched = null;
    }
  }

  const authors: string[] = (
    enriched?.creators ||
    enriched?.authors ||
    primary.authors ||
    []
  )
    .map((c: any) =>
      typeof c === 'string'
        ? c
        : c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
    )
    .filter(Boolean);

  const creators = (enriched?.creators || primary.authors || []).map(
    (c: any, index: number) => ({
      creatorType: typeof c === 'object' ? c.creatorType || 'author' : 'author',
      firstName: typeof c === 'object' ? c.firstName || '' : '',
      lastName: typeof c === 'object' ? c.lastName || '' : '',
      fullName:
        typeof c === 'string'
          ? c
          : c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
      orderIndex: index,
    }),
  );

  const itemData = {
    title: primary.title || enriched?.title || 'Untitled BibTeX Entry',
    doi: normalizedDoi || undefined,
    citationKey: primary.citationKey || undefined,
    abstract: primary.abstract || enriched?.abstract || '',
    authors: authors.length > 0 ? authors : undefined,
    creators: creators.length > 0 ? creators : undefined,
    year: primary.year
      ? parseInt(String(primary.year), 10)
      : enriched?.year
        ? parseInt(String(enriched.year), 10)
        : null,
    publicationTitle: primary.journal || enriched?.publicationTitle || '',
    journal: primary.journal || enriched?.journal || '',
    publisher: primary.publisher || enriched?.publisher || '',
    volume: primary.volume || enriched?.volume || '',
    issue: primary.issue || enriched?.issue || '',
    pages: primary.pages || enriched?.pages || '',
    url:
      primary.url ||
      (normalizedDoi ? `https://doi.org/${normalizedDoi}` : undefined),
    itemType: primary.itemType || enriched?.itemType || 'journalArticle',
    extra: `BibTeX Entry: ${primary.citationKey || 'entry'}`,
  };

  return {
    deduplicated: false,
    itemData,
  };
}
