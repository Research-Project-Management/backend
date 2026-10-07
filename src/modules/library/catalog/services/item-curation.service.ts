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
} from '../../sync';
import { ItemsMapper } from '../utils/items.mapper';

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
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Cite } = require('@citation-js/core');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@citation-js/plugin-bibtex');

      const cite = new Cite(rawCitations);
      const data = cite.data || [];
      return data.map((csl: any, index: number) => ({
        id: csl.id || `cite-${index + 1}`,
        rawCitation: rawCitations,
        title: csl.title || 'Untitled',
        authors: (csl.author || [])
          .map((a: any) => {
            if (a.literal) return a.literal.trim();
            if (a.given && a.family) return `${a.given} ${a.family}`.trim();
            return (a.family || a.given || '').trim();
          })
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
      project.members.some((m: any) => m.userId === userId);

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
        sourceItems.map((s) => ({
          doi: s.doi,
          citationKey: s.citationKey,
          title: s.title,
        })),
      );
      existingDois = new Set(
        existingItems
          .map((e) => e.doi?.trim().toLowerCase())
          .filter((d): d is string => Boolean(d)),
      );
      existingCitationKeys = new Set(
        existingItems
          .map((e) => e.citationKey?.trim().toLowerCase())
          .filter((k): k is string => Boolean(k)),
      );
      existingTitles = new Set(
        existingItems
          .map((e) => e.title?.trim().toLowerCase())
          .filter((t): t is string => Boolean(t)),
      );
    }

    for (const source of sourceItems) {
      const isBatchDuplicate =
        (source.doi && existingDois.has(source.doi.trim().toLowerCase())) ||
        (source.citationKey &&
          existingCitationKeys.has(source.citationKey.trim().toLowerCase())) ||
        (source.title && existingTitles.has(source.title.trim().toLowerCase()));

      let existingInProject: any = isBatchDuplicate;
      if (!isBatchDuplicate && !this.query.findDuplicatesInProject) {
        existingInProject = await this.query.findDuplicateInProject(projectId, {
          doi: source.doi,
          citationKey: source.citationKey,
          title: source.title,
        });
      }

      if (existingInProject) {
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
      sources: sources.map((s) => ({
        id: s.id,
        sourceProvider: s.sourceProvider,
        sourceUri: s.sourceUri,
        format: s.format,
        fetchedAt: s.fetchedAt,
        createdAt: s.createdAt,
        rawPayload: s.rawPayload,
      })),
    };
  }
}

export function buildImportItemPayload(
  source: any,
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
    tags: source.itemTags?.map((it: any) => it.tag?.name).filter(Boolean) || [],
    notes:
      source.notesList?.map((n: any) => ({
        title: n.title,
        contentMd: n.contentMd,
        content: n.contentMd,
        tags: n.tags || [],
      })) || [],
    creators: source.contributors?.map((c: any) => ({
      creatorType: c.creatorType || 'author',
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      fullName: c.fullName || '',
      name: c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
      orderIndex: c.orderIndex ?? 0,
    })),
    identifiers: source.identifiers?.map((i: any) => ({
      type: i.type,
      value: i.value,
      canonicalUri: i.canonicalUri,
    })),
  };
}
