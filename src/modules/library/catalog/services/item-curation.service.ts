import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { RedisCacheService } from '@/core';
import { ItemCacheCoordinator } from './item-cache.coordinator';
import { ItemQueryService } from './item-query.service';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { CommandRepository } from '@/modules/library/catalog/repositories/command.repository';
import {
  CreateItemData,
  BibliographicReference,
} from '@/modules/library/core/types/bibliographic.types';
import {
  LIBRARY_EVENT_TYPES,
  buildItemCreatedOutboxPayload,
  mergeCanonicalCreators,
} from '@/modules/library/core';
import { TransactionService } from '@/modules/library/sync';
import { ItemsMapper } from '@/modules/library/catalog/domain/items.mapper';

interface CslItemData {
  id?: string;
  title?: string;
  author?: Array<{ literal?: string; given?: string; family?: string }>;
  issued?: { 'date-parts'?: Array<Array<number | string>> };
  'container-title'?: string;
  journal?: string;
  volume?: string | number;
  issue?: string | number;
  page?: string | number;
  DOI?: string;
  URL?: string;
}

interface CitationJsInstance {
  data?: CslItemData[];
}

type CitationJsConstructor = new (raw: string) => CitationJsInstance;

let cachedCite: CitationJsConstructor | null | undefined = null;

function getCite(): CitationJsConstructor | undefined {
  if (cachedCite === null) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Cite } = require('@citation-js/core') as {
        Cite: CitationJsConstructor;
      };
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@citation-js/plugin-bibtex');
      cachedCite = Cite;
    } catch {
      cachedCite = undefined;
    }
  }
  return cachedCite ?? undefined;
}

/**
 * ItemCurationService — Dedicated Domain Service for Item Curation, Scholarly Enrichment,
 * Cross-Project Imports, and Metadata Source Provenance.
 */
@Injectable()
export class ItemCurationService {
  private readonly cacheCoordinator: ItemCacheCoordinator;

  constructor(
    private readonly query: QueryRepository,
    private readonly command: CommandRepository,
    private readonly libraryTx: TransactionService,
    @Optional()
    @Inject(RedisCacheService)
    cacheOrCoordinator?: RedisCacheService | ItemCacheCoordinator,
    @Optional() private readonly itemQueryService?: ItemQueryService,
    @Optional()
    @Inject(ItemCacheCoordinator)
    injectedCoordinator?: ItemCacheCoordinator,
  ) {
    if (injectedCoordinator) {
      this.cacheCoordinator = injectedCoordinator;
    } else if (cacheOrCoordinator instanceof ItemCacheCoordinator) {
      this.cacheCoordinator = cacheOrCoordinator;
    } else {
      this.cacheCoordinator = new ItemCacheCoordinator(cacheOrCoordinator);
    }
  }

  /**
   * Parses raw unformatted citation strings or multi-line bibliographies into structured references.
   */
  parseCitations(rawCitations: string): Promise<BibliographicReference[]> {
    if (
      !rawCitations ||
      typeof rawCitations !== 'string' ||
      !rawCitations.trim()
    ) {
      return Promise.resolve([]);
    }

    try {
      const Cite = getCite();
      if (!Cite) return Promise.resolve([]);

      const cite = new Cite(rawCitations);
      const data = cite.data || [];
      return Promise.resolve(
        data.map((csl: CslItemData, index: number) => ({
          id: csl.id || `cite-${index + 1}`,
          rawCitation: rawCitations,
          title: csl.title || 'Untitled',
          authors: (csl.author || [])
            .map(
              (author: {
                literal?: string;
                given?: string;
                family?: string;
              }) => {
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
        })),
      );
    } catch {
      return Promise.resolve([]);
    }
  }

  /**
   * Imports existing library items into a specific user project library.
   * Performs batch duplicate detection and transactional item duplication.
   */
  async importItemsToProject(
    userId: string,
    projectId: string,
    itemIds: string[],
  ): Promise<{ success: boolean; importedCount: number }> {
    const uniqueItemIds = Array.from(new Set(itemIds)).slice(0, 100);
    if (uniqueItemIds.length === 0) {
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

    if (this.itemQueryService) {
      const perms = await this.itemQueryService.getPermissions(userId, projectId);
      if (!perms.permissions.canImport) {
        throw new ForbiddenException(
          'You do not have permission to import items to this project',
        );
      }
    }

    const sourceItems = await this.query.findManyByIdsWithFullDetails(userId, uniqueItemIds);
    let importedCount = 0;

    // Batch query to detect duplicates in one go, avoiding N+1 queries.
    let existingDois = new Set<string>();
    let existingCitationKeys = new Set<string>();
    let existingTitles = new Set<string>();

    if (sourceItems.length > 0) {
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

    const candidatesToImport: Array<{
      source: ImportSourceItem;
      createData: CreateItemData;
    }> = [];

    for (const source of sourceItems) {
      const isDuplicate =
        Boolean(
          source.doi && existingDois.has(source.doi.trim().toLowerCase()),
        ) ||
        Boolean(
          source.title && existingTitles.has(source.title.trim().toLowerCase()),
        );

      if (isDuplicate) {
        continue;
      }

      const createData = buildImportItemPayload(source, userId);
      candidatesToImport.push({ source, createData });

      if (source.doi?.trim()) {
        existingDois.add(source.doi.trim().toLowerCase());
      }
      if (createData.citationKey?.trim()) {
        existingCitationKeys.add(createData.citationKey.trim().toLowerCase());
      }
      if (source.title?.trim()) {
        existingTitles.add(source.title.trim().toLowerCase());
      }
    }

    if (candidatesToImport.length > 0) {
      await this.libraryTx.executeInTransaction(async (tx, helpers) => {
        const changeEntries: Array<{
          entityType: 'Item';
          entityId: string;
          action: 'create';
          version: number;
          data: unknown;
        }> = [];
        const outboxEvents: Array<{
          aggregateId: string;
          eventType: string;
          payload: unknown;
        }> = [];

        for (const { createData } of candidatesToImport) {
          const item = await this.command.create(
            userId,
            createData,
            tx,
            projectId,
          );

          const domainItem = ItemsMapper.toDomain(item);
          changeEntries.push({
            entityType: 'Item',
            entityId: item.id,
            action: 'create',
            version: item.version,
            data: domainItem,
          });

          const payload = buildItemCreatedOutboxPayload({
            itemId: item.id,
            userId,
            projectId,
            title: item.title,
            source: 'external_sync',
            doi: item.doi,
          });

          outboxEvents.push({
            aggregateId: item.id,
            eventType: LIBRARY_EVENT_TYPES.ITEM_CREATED,
            payload,
          });

          importedCount++;
        }

        if (helpers.appendChangesBatch) {
          await helpers.appendChangesBatch({ userId, projectId }, changeEntries);
        } else {
          for (const entry of changeEntries) {
            await helpers.appendChange({ userId, projectId }, entry);
          }
        }

        if (helpers.publishOutboxBatch) {
          await helpers.publishOutboxBatch({ userId, projectId }, outboxEvents);
        } else {
          for (const ev of outboxEvents) {
            await helpers.publishOutbox(
              { userId, projectId },
              ev.aggregateId,
              ev.eventType,
              ev.payload,
            );
          }
        }
      });
    }

    if (importedCount > 0) {
      await this.cacheCoordinator.invalidateScopeListCache(userId, projectId);
    }

    return { success: true, importedCount };
  }

  /**
   * Retrieves raw provenance metadata records for an item across all providers (arXiv, MeXtract, CrossRef).
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

export interface ImportSourceItem {
  title: string;
  year?: number | null;
  doi?: string | null;
  abstract?: string | null;
  itemType?: string | null;
  publicationTitle?: string | null;
  publicationDate?: string | null;
  publisher?: string | null;
  place?: string | null;
  volume?: string | null;
  issue?: string | null;
  section?: string | null;
  partNumber?: string | null;
  partTitle?: string | null;
  pages?: string | null;
  series?: string | null;
  seriesTitle?: string | null;
  seriesText?: string | null;
  issn?: string | null;
  isbn?: string | null;
  pmid?: string | null;
  pmcid?: string | null;
  url?: string | null;
  language?: string | null;
  journalAbbr?: string | null;
  shortTitle?: string | null;
  rights?: string | null;
  license?: string | null;
  citationKey?: string | null;
  libraryCatalog?: string | null;
  archive?: string | null;
  archiveLocation?: string | null;
  callNumber?: string | null;
  extra?: string | null;
  arxivId?: string | null;
  citationCount?: number | null;
  referenceCount?: number | null;
  openAccessPdfUrl?: string | null;
  fileId?: string | null;
  fileUrl?: string | null;
  filename?: string | null;
  mimeType?: string | null;
  size?: number | bigint | null;
  fileHash?: string | null;
  attachments?: Array<{
    fileId?: string | null;
    url?: string | null;
    filename?: string | null;
    name?: string | null;
    mimeType?: string | null;
    size?: number | bigint | null;
    fileHash?: string | null;
  }>;
  itemTags?: Array<{ tag?: { name?: string } }>;
  notesList?: Array<{ title?: string; contentMd?: string; tags?: string[] }>;
  contributors?: Array<{
    creatorType?: string;
    firstName?: string | null;
    lastName?: string | null;
    fullName?: string;
    orderIndex?: number;
  }>;
  identifiers?: Array<{ type: string; value: string; canonicalUri?: string }>;
  [key: string]: unknown;
}

export function buildImportItemPayload(
  rawSource: ImportSourceItem,
  userId: string,
): CreateItemData {
  const unpacked = ItemsMapper.toDomain(rawSource) as Record<string, unknown>;
  const source: ImportSourceItem = {
    ...unpacked,
    ...rawSource,
    publicationDate:
      rawSource.publicationDate ??
      (unpacked.publicationDate as string | null | undefined) ??
      (unpacked.date as string | null | undefined),
    publisher:
      rawSource.publisher ?? (unpacked.publisher as string | null | undefined),
    place: rawSource.place ?? (unpacked.place as string | null | undefined),
    volume: rawSource.volume ?? (unpacked.volume as string | null | undefined),
    issue: rawSource.issue ?? (unpacked.issue as string | null | undefined),
    section:
      rawSource.section ?? (unpacked.section as string | null | undefined),
    partNumber:
      rawSource.partNumber ??
      (unpacked.partNumber as string | null | undefined),
    partTitle:
      rawSource.partTitle ?? (unpacked.partTitle as string | null | undefined),
    pages: rawSource.pages ?? (unpacked.pages as string | null | undefined),
    series: rawSource.series ?? (unpacked.series as string | null | undefined),
    seriesTitle:
      rawSource.seriesTitle ??
      (unpacked.seriesTitle as string | null | undefined),
    seriesText:
      rawSource.seriesText ??
      (unpacked.seriesText as string | null | undefined),
    issn: rawSource.issn ?? (unpacked.issn as string | null | undefined),
    isbn: rawSource.isbn ?? (unpacked.isbn as string | null | undefined),
    pmid: rawSource.pmid ?? (unpacked.pmid as string | null | undefined),
    pmcid: rawSource.pmcid ?? (unpacked.pmcid as string | null | undefined),
    arxivId:
      rawSource.arxivId ?? (unpacked.arxivId as string | null | undefined),
    language:
      rawSource.language ?? (unpacked.language as string | null | undefined),
    journalAbbr:
      rawSource.journalAbbr ??
      (unpacked.journalAbbreviation as string | null | undefined) ??
      (unpacked.journalAbbr as string | null | undefined),
    shortTitle:
      rawSource.shortTitle ??
      (unpacked.shortTitle as string | null | undefined),
    rights: rawSource.rights ?? (unpacked.rights as string | null | undefined),
    license:
      rawSource.license ?? (unpacked.license as string | null | undefined),
    libraryCatalog:
      rawSource.libraryCatalog ??
      (unpacked.libraryCatalog as string | null | undefined),
    archive:
      rawSource.archive ?? (unpacked.archive as string | null | undefined),
    archiveLocation:
      rawSource.archiveLocation ??
      (unpacked.archiveLocation as string | null | undefined),
    callNumber:
      rawSource.callNumber ??
      (unpacked.callNumber as string | null | undefined),
    extra: rawSource.extra ?? (unpacked.extra as string | null | undefined),
    citationCount:
      rawSource.citationCount ??
      (unpacked.citationCount as number | null | undefined),
    referenceCount:
      rawSource.referenceCount ??
      (unpacked.referenceCount as number | null | undefined),
    openAccessPdfUrl:
      rawSource.openAccessPdfUrl ??
      (unpacked.openAccessPdfUrl as string | null | undefined),
  };
  const primaryAttachment = rawSource.attachments?.[0];
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
  const rawSize = primaryAttachment?.size ?? source.size;
  const resolvedSize =
    rawSize !== undefined && rawSize !== null ? Number(rawSize) : undefined;
  const resolvedFileHash =
    primaryAttachment?.fileHash || source.fileHash || undefined;

  const clonedAttachments = (source.attachments || []).map((att) => ({
    title: att.name || att.filename || 'document.pdf',
    filename: att.filename || att.name || 'document.pdf',
    url: att.url || (att.fileId ? `/api/files/${att.fileId}/content` : ''),
    fileId: att.fileId ? String(att.fileId) : null,
    fileHash: att.fileHash || '',
    mimeType: att.mimeType || 'application/pdf',
    size: att.size !== undefined && att.size !== null ? Number(att.size) : 0,
    linkMode: (att as Record<string, unknown>).linkMode as string | undefined,
    attachmentType: (att as Record<string, unknown>).attachmentType as string | undefined,
    metadata: (att as Record<string, unknown>).metadata as Record<string, unknown> | undefined,
    annotations: Array.isArray((att as Record<string, unknown>).annotations)
      ? ((att as Record<string, unknown>).annotations as Array<Record<string, unknown>>)
          .filter((ann) => ann && !ann.deletedAt)
          .map((ann) => ({
            type: ann.type || 'highlight',
            color: ann.color || '#ffeb3b',
            pageIndex: typeof ann.pageIndex === 'number' ? ann.pageIndex : 0,
            pageLabel: typeof ann.pageLabel === 'string' ? ann.pageLabel : '',
            annotationSortIndex:
              typeof ann.annotationSortIndex === 'string'
                ? ann.annotationSortIndex
                : '',
            rectCoords: ann.rectCoords ?? null,
            quoteText: typeof ann.quoteText === 'string' ? ann.quoteText : null,
            comment: typeof ann.comment === 'string' ? ann.comment : '',
            tags: Array.isArray(ann.tags) ? (ann.tags as string[]) : [],
            authorId: userId,
          }))
      : [],
  }));

  return {
    title: source.title,
    attachmentCount: clonedAttachments.length,
    attachments: clonedAttachments,
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
    extraFields:
      (unpacked.extraFields as Record<string, unknown> | undefined) ??
      undefined,
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
    creators: mergeCanonicalCreators({
      contributors: source.contributors,
      itemType: source.itemType || 'journalArticle',
    }),
    identifiers: source.identifiers?.map(
      (identifier: { type: string; value: string; canonicalUri?: string }) => ({
        type: identifier.type,
        value: identifier.value,
        canonicalUri: identifier.canonicalUri,
      }),
    ),
  };
}
