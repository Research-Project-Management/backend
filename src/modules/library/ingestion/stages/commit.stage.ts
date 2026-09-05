import { Injectable } from '@nestjs/common';
import { CatalogService } from '../../items/items.service';
import { ItemMetadata } from '../metadata/types/metadata.types';
import { CreateCatalogItemData } from '../../items/items.repository';
import { LibraryItemSource } from '../../outbox/outbox.events';

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

function splitAuthorNameString(input: unknown): string[] {
  if (!input) return [];
  let str = '';
  if (typeof input === 'string') {
    str = input;
  } else if (typeof input === 'object' && input !== null) {
    const obj = input as any;
    str =
      obj.fullName ||
      obj.name ||
      [obj.firstName, obj.lastName].filter(Boolean).join(' ') ||
      '';
  } else {
    str = String(input);
  }
  if (!str.trim()) return [];
  const trimmed = str.trim();
  const lines = trimmed.split(/\r?\n+/).map((s) => s.trim()).filter(Boolean);
  const result: string[] = [];

  for (const line of lines) {
    if (line.includes(';')) {
      result.push(...line.split(';').map((s) => s.trim()).filter(Boolean));
    } else if (/\s+and\s+/i.test(line)) {
      result.push(...line.split(/\s+and\s+/i).map((s) => s.trim()).filter(Boolean));
    } else if (/\s+&\s+/.test(line)) {
      result.push(...line.split(/\s+&\s+/).map((s) => s.trim()).filter(Boolean));
    } else if (line.includes(',')) {
      const parts = line.split(',').map((s) => s.trim()).filter(Boolean);
      const partsWithSpaces = parts.filter((p) => p.includes(' '));
      if (parts.length > 2 && partsWithSpaces.length >= Math.floor(parts.length / 2)) {
        result.push(...parts);
      } else if (parts.length > 2 && parts.length % 2 === 0) {
        for (let i = 0; i < parts.length; i += 2) {
          result.push(`${parts[i]}, ${parts[i + 1]}`);
        }
      } else {
        result.push(line);
      }
    } else {
      result.push(line);
    }
  }

  return result;
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
    const rawName =
      c.fullName ||
      c.name ||
      [c.firstName, c.lastName].filter(Boolean).join(' ');
    if (rawName) {
      for (const p of splitAuthorNameString(rawName)) {
        append(p, creatorType);
      }
    }
  }

  for (const rawAuthor of metadata.authors || []) {
    for (const author of splitAuthorNameString(rawAuthor)) {
      append(author, 'author');
    }
  }

  for (const rawEditor of metadata.editors || []) {
    for (const editor of splitAuthorNameString(rawEditor)) {
      append(editor, 'editor');
    }
  }

  return creators.length > 0 ? creators : undefined;
}

/** Converts reconciled provider metadata to the Catalog persistence contract.
 * This is the sole conversion used by the asynchronous ingestion path. */
export function toCatalogItemData(
  metadata: ItemMetadata,
  options?: CommitStageOptions,
): CreateCatalogItemData {
  const rawTags = metadata.tags || metadata.keywords || metadata.labels || [];
  const extraFields = {
    ...(metadata.extraFields || {}),
    ...(metadata.abstractNote !== undefined
      ? { abstractNote: metadata.abstractNote }
      : {}),
    ...(metadata.tldr !== undefined ? { tldr: metadata.tldr } : {}),
    ...(metadata.citationCount !== undefined
      ? { citationCount: metadata.citationCount }
      : {}),
    ...(metadata.referenceCount !== undefined
      ? { referenceCount: metadata.referenceCount }
      : {}),
    ...(metadata.influentialCitationCount !== undefined
      ? { influentialCitationCount: metadata.influentialCitationCount }
      : {}),
    ...(metadata.openAccessPdfUrl !== undefined
      ? { openAccessPdfUrl: metadata.openAccessPdfUrl }
      : {}),
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
    citationKey: metadata.citationKey,
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
    extra: metadata.extra,
    extraFields,
    notes: metadata.notes,
    collectionId: options?.collectionIds?.[0] || null,
    collectionIds: options?.collectionIds,
    uploadedById: options?.userId || 'system',
  };
}

@Injectable()
export class CommitStage {
  constructor(private readonly catalogService: CatalogService) {}

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

    const createdItem = await this.catalogService.createItem(
      workspaceId,
      createData,
      {
        source: (options?.source as any) || 'manual',
      },
    );

    return createdItem;
  }
}
