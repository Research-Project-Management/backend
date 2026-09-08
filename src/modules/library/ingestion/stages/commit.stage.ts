import { Injectable } from '@nestjs/common';
import { ItemsService } from '../../items/items.service';
import { ItemMetadata } from '../metadata/types/metadata.types';
import { CreateCatalogItemData } from '../../items/types/items.types';
import { LibraryItemSource } from '../../outbox/outbox.events';
import { splitAuthorString } from '../../items/utils/items.utils';
import { normalizeTags } from '../../tags/utils/tags.utils';

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

function mergeCreators(metadata: ItemMetadata) {
  const initialCreators = metadata.creators || [];
  const creators: any[] = [];
  const knownCreators = new Set<string>();

  const append = (name: string, creatorType: string = 'author') => {
    const normalizedName = name.trim();
    if (!normalizedName) return;
    const key = `${creatorType}:${normalizedName.toLocaleLowerCase()}`;
    if (knownCreators.has(key)) return;
    knownCreators.add(key);
    creators.push({ name: normalizedName, creatorType });
  };

  for (const c of initialCreators) {
    const creatorType = c.creatorType || 'author';
    const rawName = extractAuthorString(c);
    if (rawName) {
      for (const p of splitAuthorString(rawName)) {
        append(p, creatorType);
      }
    }
  }

  for (const rawAuthor of metadata.authors || []) {
    for (const author of splitAuthorString(extractAuthorString(rawAuthor))) {
      append(author, 'author');
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

/** Converts reconciled provider metadata to the Catalog persistence contract.
 * This is the sole conversion used by the asynchronous ingestion path. */
export function toCatalogItemData(
  metadata: ItemMetadata,
  options?: CommitStageOptions,
): CreateCatalogItemData {
  const rawTags = normalizeTags(
    metadata.tags || metadata.keywords || metadata.labels || [],
  );
  // Only fields with no dedicated DB column go into extraFields
  const extraFields: Record<string, unknown> = {
    ...(metadata.extraFields || {}),
    ...(metadata.storageId !== undefined
      ? { storageId: metadata.storageId }
      : {}),
    ...(metadata.explicitCitationKey !== undefined
      ? { explicitCitationKey: metadata.explicitCitationKey }
      : {}),
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
    publicationTitle: metadata.publicationTitle ?? metadata.journal,
    journal: metadata.journal,
    journalAbbr: metadata.journalAbbr,
    publisher: metadata.publisher,
    place: metadata.place,
    volume: metadata.volume,
    issue: metadata.issue,
    section: metadata.section,
    partNumber: metadata.partNumber,
    partTitle: metadata.partTitle,
    pages: metadata.pages,
    series: metadata.series,
    seriesTitle: metadata.seriesTitle,
    seriesText: metadata.seriesText,
    seriesNumber: metadata.seriesNumber,
    abstract: metadata.abstract ?? metadata.abstractNote,
    url: metadata.url,
    citationKey: metadata.citationKey || generateBibtexCitationKey(metadata),
    shortTitle: metadata.shortTitle,
    creators: mergeCreators(metadata),
    labels: rawTags,
    keywords: rawTags,
    fileId: options?.fileId || metadata.fileId || undefined,
    filename: options?.filename || metadata.filename || undefined,
    fileUrl:
      metadata.fileUrl ||
      metadata.pdfUrl ||
      metadata.openAccessPdfUrl ||
      undefined,
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
    extraFields,
    notes: (() => {
      const consolidatedNotes: Array<Record<string, unknown> | string> =
        Array.isArray(metadata.notes) ? [...metadata.notes] : [];
      const potentialComment =
        typeof extraFields.comment === 'string'
          ? extraFields.comment.trim()
          : '';
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
  constructor(private readonly itemsService: ItemsService) {}

  /**
   * Executes canonical Catalog commit for a reconciled item proposal.
   * Persists CatalogItem, child attachments, tags/keywords, and literature notes.
   */
  async execute(
    workspaceId: string,
    metadata: ItemMetadata,
    options?: CommitStageOptions,
  ): Promise<any> {
    const createData = toCatalogItemData(metadata, options);

    const createdItem = await this.itemsService.createItem(
      workspaceId,
      createData,
      {
        source: (options?.source as any) || 'manual',
      },
    );

    return createdItem;
  }
}
