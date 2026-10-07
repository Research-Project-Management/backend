import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { QueryRepository } from '../repositories/query.repository';
import { CommandRepository } from '../repositories/command.repository';
import { CreateItemData } from '../types/items.types';
import { BibliographicReference } from '../../shared-kernel/types/bibliographic.types';
import {
  TransactionService,
  LIBRARY_EVENT_TYPES,
  buildItemCreatedOutboxPayload,
} from '../../shared-kernel';
import { ItemsMapper } from '../utils/items.mapper';

let cachedCite: any = null;

function getCite(): any {
  if (cachedCite === null) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Cite } = require('@citation-js/core');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@citation-js/plugin-bibtex');
      cachedCite = Cite;
    } catch {
      cachedCite = undefined;
    }
  }
  return cachedCite;
}

/**
 * ItemCurationService — Dedicated Domain Service for Item Curation, Scholarly Enrichment,
 * Cross-Project Imports, and Metadata Source Provenance.
 */
@Injectable()
export class ItemCurationService {
  constructor(
    private readonly query: QueryRepository,
    private readonly command: CommandRepository,
    private readonly libraryTx: TransactionService,
  ) {}

  /**
   * Parses raw unformatted citation strings or multi-line bibliographies into structured references.
   */
  async parseCitations(
    rawCitations: string,
  ): Promise<BibliographicReference[]> {
    if (
      !rawCitations ||
      typeof rawCitations !== 'string' ||
      !rawCitations.trim()
    ) {
      return [];
    }

    try {
      const Cite = getCite();
      if (!Cite) return [];

      const cite = new Cite(rawCitations);
      const data = cite.data || [];
      return data.map((csl: Record<string, any>, index: number) => ({
        id: csl.id || `cite-${index + 1}`,
        rawCitation: rawCitations,
        title: csl.title || 'Untitled',
        authors: (csl.author || [])
          .map(
            (author: { literal?: string; given?: string; family?: string }) => {
              if (author.literal) return author.literal.trim();
              if (author.given && author.family)
                return `${author.given} ${author.family}`.trim();
              return (author.family || author.given || '').trim();
            },
          )
          .filter(Boolean),
        year:
          csl.issued?.['date-parts']?.[0]?.[0] != null
            ? Number(csl.issued['date-parts'][0][0])
            : undefined,
        journal: csl['container-title'] || csl.journal || undefined,
        volume: csl.volume ? String(csl.volume) : undefined,
        issue: csl.issue ? String(csl.issue) : undefined,
        pages: csl.page ? String(csl.page) : undefined,
        doi: csl.DOI || undefined,
        url: csl.URL || undefined,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Imports existing library items into a specific collaborative project workspace.
   * Performs batch duplicate detection and transactional item duplication.
   */
  async importItemsToProject(
    userId: string,
    projectId: string,
    itemIds: string[],
  ): Promise<{ success: boolean; importedCount: number }> {
    if (!itemIds || itemIds.length === 0) {
      return { success: true, importedCount: 0 };
    }

    const project = await this.query.findProjectWithMembers(projectId);

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const isMember =
      project.createdById === userId ||
      project.members.some(
        (member: { userId: string }) => member.userId === userId,
      );

    if (!isMember) {
      throw new ForbiddenException(
        'You do not have permission to import items to this project',
      );
    }

    const sourceItems = await this.query.findByIds(userId, itemIds);
    let importedCount = 0;

    // Batch query to detect duplicates in one go, avoiding N+1 queries.
    let existingDois = new Set<string>();
    let existingCitationKeys = new Set<string>();
    let existingTitles = new Set<string>();

    if (this.query.findDuplicatesInProject && sourceItems.length > 0) {
      const existingItems = await this.query.findDuplicatesInProject(
        projectId,
        sourceItems.map((item) => ({
          doi: item.doi,
          citationKey: item.citationKey,
          title: item.title,
        })),
      );
      existingDois = new Set(
        existingItems
          .map((entry) => entry.doi?.trim().toLowerCase())
          .filter((doi): doi is string => Boolean(doi)),
      );
      existingCitationKeys = new Set(
        existingItems
          .map((entry) => entry.citationKey?.trim().toLowerCase())
          .filter((key): key is string => Boolean(key)),
      );
      existingTitles = new Set(
        existingItems
          .map((entry) => entry.title?.trim().toLowerCase())
          .filter((title): title is string => Boolean(title)),
      );
    }

    for (const source of sourceItems) {
      const isBatchDuplicate =
        Boolean(
          source.doi && existingDois.has(source.doi.trim().toLowerCase()),
        ) ||
        Boolean(
          source.citationKey &&
          existingCitationKeys.has(source.citationKey.trim().toLowerCase()),
        ) ||
        Boolean(
          source.title && existingTitles.has(source.title.trim().toLowerCase()),
        );

      let isDuplicate = isBatchDuplicate;
      if (!isBatchDuplicate && !this.query.findDuplicatesInProject) {
        const found = await this.query.findDuplicateInProject(projectId, {
          doi: source.doi,
          citationKey: source.citationKey,
          title: source.title,
        });
        isDuplicate = Boolean(found);
      }

      if (isDuplicate) {
        continue;
      }

      const createData = buildImportItemPayload(source, userId);

      await this.libraryTx.executeInTransaction(async (tx, helpers) => {
        const item = await this.command.create(
          userId,
          createData,
          tx,
          projectId,
        );

        await helpers.appendChange(
          { userId, projectId },
          {
            entityType: 'Item',
            entityId: item.id,
            action: 'create',
            version: item.version,
            data: item,
          },
        );

        const payload = buildItemCreatedOutboxPayload({
          itemId: item.id,
          userId,
          projectId,
          title: item.title,
          source: 'external_sync',
          doi: item.doi,
        });

        await helpers.publishOutbox(
          { userId, projectId },
          item.id,
          LIBRARY_EVENT_TYPES.ITEM_CREATED,
          payload,
        );

        return ItemsMapper.toDomain(item);
      });

      importedCount++;
    }

    return { success: true, importedCount };
  }

  /**
   * Retrieves raw provenance metadata records for an item across all providers (arXiv, Grobid, CrossRef).
   */
  async getMetadataSources(userId: string, itemId: string, projectId?: string) {
    const item = await this.query.findById(userId, itemId, projectId);
    if (!item) {
      throw new NotFoundException(`Item ${itemId} not found in library`);
    }
    const sources = await this.query.findMetadataSources(itemId);
    return {
      itemId,
      count: sources.length,
      sources: sources.map((source) => ({
        id: source.id,
        sourceProvider: source.sourceProvider,
        sourceUri: source.sourceUri,
        format: source.format,
        fetchedAt: source.fetchedAt,
        createdAt: source.createdAt,
        rawPayload: source.rawPayload,
      })),
    };
  }
}

export function buildImportItemPayload(
  source: Record<string, any>,
  userId: string,
): CreateItemData {
  const primaryAttachment = source.attachments?.[0];
  const resolvedFileId = primaryAttachment?.fileId
    ? String(primaryAttachment.fileId)
    : source.fileId
      ? String(source.fileId)
      : undefined;
  const resolvedFileUrl = primaryAttachment?.url || source.fileUrl || undefined;
  const resolvedFilename =
    primaryAttachment?.filename ||
    primaryAttachment?.name ||
    source.filename ||
    undefined;
  const resolvedMimeType =
    primaryAttachment?.mimeType || source.mimeType || undefined;
  const resolvedSize = primaryAttachment?.size || source.size || undefined;
  const resolvedFileHash =
    primaryAttachment?.fileHash || source.fileHash || undefined;

  return {
    title: source.title,
    uploadedById: userId,
    year: source.year ?? undefined,
    doi: source.doi ?? undefined,
    abstract: source.abstract ?? undefined,
    itemType: source.itemType || 'journalArticle',
    publicationTitle: source.publicationTitle ?? undefined,
    publicationDate: source.publicationDate ?? undefined,
    publisher: source.publisher ?? undefined,
    place: source.place ?? undefined,
    volume: source.volume ?? undefined,
    issue: source.issue ?? undefined,
    section: source.section ?? undefined,
    partNumber: source.partNumber ?? undefined,
    partTitle: source.partTitle ?? undefined,
    pages: source.pages ?? undefined,
    series: source.series ?? undefined,
    seriesTitle: source.seriesTitle ?? undefined,
    seriesText: source.seriesText ?? undefined,
    issn: source.issn ?? undefined,
    isbn: source.isbn ?? undefined,
    pmid: source.pmid ?? undefined,
    pmcid: source.pmcid ?? undefined,
    url: source.url ?? undefined,
    language: source.language ?? undefined,
    journalAbbr: source.journalAbbr ?? undefined,
    shortTitle: source.shortTitle ?? undefined,
    rights: source.rights ?? undefined,
    license: source.license ?? undefined,
    citationKey: source.citationKey ?? undefined,
    libraryCatalog: source.libraryCatalog ?? undefined,
    archive: source.archive ?? undefined,
    archiveLocation: source.archiveLocation ?? undefined,
    callNumber: source.callNumber ?? undefined,
    extra: source.extra ?? undefined,
    arxivId: source.arxivId ?? undefined,
    citationCount: source.citationCount ?? undefined,
    referenceCount: source.referenceCount ?? undefined,
    openAccessPdfUrl: source.openAccessPdfUrl ?? undefined,
    fileId: resolvedFileId,
    fileUrl: resolvedFileUrl,
    filename: resolvedFilename,
    mimeType: resolvedMimeType,
    size: resolvedSize,
    fileHash: resolvedFileHash,
    tags:
      source.itemTags
        ?.map((itemTag: { tag?: { name?: string } }) => itemTag.tag?.name)
        .filter((tagName: unknown): tagName is string => Boolean(tagName)) ||
      [],
    notes:
      source.notesList?.map(
        (note: { title?: string; contentMd?: string; tags?: string[] }) => ({
          title: note.title,
          contentMd: note.contentMd,
          content: note.contentMd,
          tags: note.tags || [],
        }),
      ) || [],
    creators: source.contributors?.map(
      (contributor: {
        creatorType?: string;
        firstName?: string;
        lastName?: string;
        fullName?: string;
        orderIndex?: number;
      }) => ({
        creatorType: contributor.creatorType || 'author',
        firstName: contributor.firstName || '',
        lastName: contributor.lastName || '',
        fullName: contributor.fullName || '',
        name:
          contributor.fullName ||
          `${contributor.firstName || ''} ${contributor.lastName || ''}`.trim(),
        orderIndex: contributor.orderIndex ?? 0,
      }),
    ),
    identifiers: source.identifiers?.map(
      (identifier: { type: string; value: string; canonicalUri?: string }) => ({
        type: identifier.type,
        value: identifier.value,
        canonicalUri: identifier.canonicalUri,
      }),
    ),
  };
}
