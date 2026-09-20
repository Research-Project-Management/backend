import { Injectable, Inject } from '@nestjs/common';
import {
  BIBLIOGRAPHY_FACADE,
  IBibliographyFacade,
  CATALOG_FACADE,
  ICatalogFacade,
} from '../../../bibliography/bibliography.facade';
import { ItemMetadata } from '../../domain/types/metadata.types';
import { CreateItemData } from '../../../shared-kernel/types/bibliographic.types';
import { LibraryItemSource } from '../../../shared-kernel/outbox/outbox.events';
import {
  splitAuthorString,
  cleanAbstractText,
  cleanCommentText,
  parseCreatorString,
} from '../../../shared-kernel/utils/bibliographic.utils';
import { normalizeTags } from '../../../shared-kernel/utils/tag.utils';

export interface CommitStageOptions {
  collectionIds?: string[];
  tagIds?: string[];
  userId?: string;
  source?: LibraryItemSource;
  fileId?: string;
  filename?: string;
}

function normalizeAccessedAt(
  value: ItemMetadata['accessedAt'],
): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function extractAuthorString(input: unknown): string {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'object' && input !== null) {
    const obj = input as any;
    return (
      obj.fullName ||
      obj.name ||
      [obj.firstName, obj.lastName].filter(Boolean).join(' ') ||
      ''
    );
  }
  if (typeof input === 'number' || typeof input === 'boolean') {
    return String(input);
  }
  return '';
}

function mergeCreators(metadata: ItemMetadata, primaryRole: string = 'author') {
  const initialCreators = metadata.creators || [];
  const creators: any[] = [];
  const knownCreators = new Set<string>();

  const append = (
    name: string,
    creatorType: string = primaryRole,
    firstName?: string,
    lastName?: string,
  ) => {
    const cleanName = (name || '').trim();
    let finalFirst = firstName?.trim() || '';
    let finalLast = lastName?.trim() || '';
    let finalFull = cleanName;

    if (cleanName.includes(',') || (!finalFirst && !finalLast)) {
      const parsed = parseCreatorString(
        cleanName || `${finalFirst} ${finalLast}`.trim(),
        0,
        creatorType,
      );
      finalFirst = parsed.firstName || finalFirst;
      finalLast = parsed.lastName || finalLast;
      finalFull = parsed.fullName;
    } else if (!finalFull) {
      finalFull = `${finalFirst} ${finalLast}`.trim();
    }

    if (!finalFull && !finalFirst && !finalLast) return;

    const dedupKey =
      finalLast || finalFirst
        ? `${creatorType}:${finalLast.toLowerCase()}:${finalFirst.toLowerCase()}`
        : `${creatorType}:${finalFull.toLowerCase()}`;

    if (knownCreators.has(dedupKey)) return;
    knownCreators.add(dedupKey);

    creators.push({
      name: finalFull || `${finalFirst} ${finalLast}`.trim(),
      fullName: finalFull || `${finalFirst} ${finalLast}`.trim(),
      creatorType,
      firstName: finalFirst || '',
      lastName: finalLast || '',
    });
  };

  for (const c of initialCreators) {
    const creatorType = c.creatorType || primaryRole;
    const rawName = extractAuthorString(c);
    if (rawName) {
      for (const p of splitAuthorString(rawName)) {
        append(
          p,
          creatorType,
          c.firstName || undefined,
          c.lastName || undefined,
        );
      }
    } else if (c.firstName || c.lastName) {
      append(
        '',
        creatorType,
        c.firstName || undefined,
        c.lastName || undefined,
      );
    }
  }

  for (const rawAuthor of metadata.authors || []) {
    for (const author of splitAuthorString(extractAuthorString(rawAuthor))) {
      append(author, primaryRole);
    }
  }

  for (const rawEditor of metadata.editors || []) {
    for (const editor of splitAuthorString(extractAuthorString(rawEditor))) {
      append(editor, 'editor');
    }
  }

  return creators.length > 0 ? creators : undefined;
}

function generateBibtexCitationKey(metadata: ItemMetadata): string | undefined {
  if (metadata.citationKey && metadata.citationKey.trim()) {
    return metadata.citationKey.trim().replace(/\s+/g, '');
  }
  const firstAuthor =
    metadata.authors?.[0] ||
    metadata.creators?.[0]?.lastName ||
    metadata.creators?.[0]?.fullName;
  if (!firstAuthor && !metadata.title) {
    return undefined;
  }
  let authorPart = 'ref';
  if (firstAuthor) {
    const authorTokens = firstAuthor.trim().split(/\s+/);
    authorPart = (authorTokens[authorTokens.length - 1] || firstAuthor)
      .toLowerCase()
      .replace(/[^a-z0-9]/gi, '');
  }
  const yearPart = metadata.year ? String(metadata.year) : '';
  const stopWords = new Set([
    'a',
    'an',
    'the',
    'on',
    'in',
    'for',
    'of',
    'and',
    'with',
    'via',
    'to',
    'is',
    'are',
  ]);
  let titlePart = 'paper';
  if (metadata.title) {
    for (const wordItem of metadata.title.trim().split(/\s+/)) {
      const cleanWord = wordItem.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (cleanWord && !stopWords.has(cleanWord)) {
        titlePart = cleanWord;
        break;
      }
    }
  }
  return `${authorPart || 'ref'}${yearPart}${titlePart || 'paper'}`;
}

/** Converts reconciled provider metadata to the Item persistence contract.
 * This is the sole conversion used by the asynchronous ingestion path. */
export function toItemData(
  metadata: ItemMetadata,
  options?: CommitStageOptions,
  primaryRole: string = 'author',
): CreateItemData {
  const rawTags = normalizeTags(
    metadata.tags || metadata.keywords || metadata.labels || [],
  );
  // Only fields with no dedicated DB column go into extraFields
  const extraFields: Record<string, unknown> = {
    ...(metadata.extraFields || {}),
    ...(metadata.edition ? { edition: metadata.edition } : {}),
    ...(metadata.repository ? { repository: metadata.repository } : {}),
    ...(metadata.bookTitle ? { bookTitle: metadata.bookTitle } : {}),
    ...(metadata.conferenceName &&
    metadata.conferenceName !==
      (metadata.publicationTitle ??
        metadata.proceedingsTitle ??
        metadata.journal)
      ? { conferenceName: metadata.conferenceName }
      : {}),
    ...(metadata.eventPlace ? { eventPlace: metadata.eventPlace } : {}),
    ...(metadata.websiteTitle ? { websiteTitle: metadata.websiteTitle } : {}),
    ...(metadata.websiteType ? { websiteType: metadata.websiteType } : {}),
    ...(metadata.blogTitle ? { blogTitle: metadata.blogTitle } : {}),
    ...(metadata.university ? { university: metadata.university } : {}),
    ...(metadata.institution ? { institution: metadata.institution } : {}),
    ...(metadata.numPages !== undefined ? { numPages: metadata.numPages } : {}),
    ...(metadata.numberOfPages !== undefined
      ? { numberOfPages: metadata.numberOfPages }
      : {}),
    ...(metadata.reportNumber ? { reportNumber: metadata.reportNumber } : {}),
    ...(metadata.reportType ? { reportType: metadata.reportType } : {}),
    ...(metadata.thesisType ? { thesisType: metadata.thesisType } : {}),
    ...(metadata.versionNumber
      ? { versionNumber: metadata.versionNumber }
      : {}),
    ...(metadata.patentNumber ? { patentNumber: metadata.patentNumber } : {}),
    ...(metadata.applicationNumber
      ? { applicationNumber: metadata.applicationNumber }
      : {}),
    ...(metadata.assignee ? { assignee: metadata.assignee } : {}),
    ...(metadata.issuingAuthority
      ? { issuingAuthority: metadata.issuingAuthority }
      : {}),
    ...(metadata.distributor ? { distributor: metadata.distributor } : {}),
    ...(metadata.system ? { system: metadata.system } : {}),
  };

  return {
    title: metadata.title || 'Untitled Document',
    itemType: metadata.itemType || 'journalArticle',
    type: metadata.type,
    doi: metadata.doi,
    arxivId: metadata.arxivId,
    pmid: metadata.pmid,
    pmcid: metadata.pmcid,
    issn: metadata.issn,
    isbn: metadata.isbn,
    year: metadata.year ?? undefined,
    publicationDate: metadata.publicationDate ?? metadata.date,
    publicationTitle:
      metadata.publicationTitle ??
      metadata.journal ??
      metadata.bookTitle ??
      metadata.proceedingsTitle ??
      metadata.websiteTitle ??
      metadata.blogTitle,
    journal: metadata.journal,
    journalAbbr: metadata.journalAbbr,
    publisher:
      metadata.publisher ?? metadata.institution ?? metadata.university,
    place: metadata.place ?? metadata.eventPlace,
    volume: metadata.volume,
    issue: metadata.issue,
    section: metadata.section,
    partNumber: metadata.partNumber,
    partTitle: metadata.partTitle,
    pages: metadata.pages || undefined,
    series: metadata.series,
    seriesTitle: metadata.seriesTitle,
    seriesText: metadata.seriesText,
    seriesNumber: metadata.seriesNumber,
    abstract:
      cleanAbstractText(metadata.abstract ?? metadata.abstractNote) ??
      undefined,
    url: metadata.url,
    citationKey: metadata.citationKey || generateBibtexCitationKey(metadata),
    shortTitle: metadata.shortTitle,
    creators: mergeCreators(metadata, primaryRole),
    labels: rawTags,
    keywords: rawTags,
    fileId: options?.fileId || metadata.fileId || undefined,
    filename: options?.filename || metadata.filename || undefined,
    fileUrl:
      metadata.fileUrl ||
      metadata.pdfUrl ||
      metadata.openAccessPdfUrl ||
      undefined,
    openAccessPdfUrl: metadata.openAccessPdfUrl || undefined,
    language: metadata.language,
    rights: metadata.rights,
    license: metadata.license,
    archive: metadata.archive,
    archiveLocation: metadata.archiveLocation,
    libraryCatalog: metadata.libraryCatalog,
    callNumber: metadata.callNumber,
    accessedAt: normalizeAccessedAt(metadata.accessedAt),
    citationCount: metadata.citationCount ?? null,
    referenceCount: metadata.referenceCount ?? null,
    extra: metadata.extra,
    extraFields: (() => {
      const cleanEf = { ...extraFields };
      delete cleanEf.comment;
      return cleanEf;
    })(),
    notes: (() => {
      const consolidatedNotes: Array<Record<string, unknown> | string> =
        Array.isArray(metadata.notes) ? [...metadata.notes] : [];
      const potentialComment =
        typeof extraFields.comment === 'string'
          ? cleanCommentText(extraFields.comment)
          : undefined;
      if (potentialComment) {
        const hasExistingCommentNote = consolidatedNotes.some((singleNote) => {
          if (typeof singleNote === 'string') {
            return singleNote.includes(potentialComment);
          }
          if (typeof singleNote === 'object' && singleNote !== null) {
            const noteObj = singleNote;
            const content =
              typeof noteObj.content === 'string' ? noteObj.content : '';
            return content.includes(potentialComment);
          }
          return false;
        });

        if (!hasExistingCommentNote) {
          consolidatedNotes.push({
            content: `Comment: ${potentialComment}`,
            source: 'arXiv',
          });
        }
      }
      return consolidatedNotes;
    })(),
    collectionId: options?.collectionIds?.[0] || null,
    collectionIds: options?.collectionIds,
    uploadedById: options?.userId || 'system',
  };
}

@Injectable()
export class CommitStage {
  constructor(
    @Inject(CATALOG_FACADE) private readonly catalogFacade: ICatalogFacade,
  ) {}

  /**
   * Executes canonical Item commit for a reconciled item proposal.
   * Persists Item, child attachments, tags/keywords, and literature notes.
   */
  async execute(
    scopeId: string,
    metadata: ItemMetadata,
    options?: CommitStageOptions,
  ): Promise<any> {
    const primaryRole =
      this.catalogFacade?.getPrimaryCreatorType?.(
        metadata.itemType || 'journalArticle',
      ) || 'author';
    const createData = toItemData(metadata, options, primaryRole);

    const isProject =
      Boolean(scopeId) && scopeId !== 'user' && scopeId !== options?.userId;
    const effectiveUserId = options?.userId || scopeId;
    const effectiveProjectId = isProject ? scopeId : undefined;

    if (effectiveProjectId) {
      createData.projectId = effectiveProjectId;
    }

    const createdItem = await this.catalogFacade.createItem(
      effectiveUserId,
      createData,
      {
        source: (options?.source as any) || 'manual',
        projectId: effectiveProjectId,
      },
    );

    return createdItem;
  }
}
