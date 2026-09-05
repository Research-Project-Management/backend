import { Injectable } from '@nestjs/common';
import { normalizeDoi } from '../../library/items/items.utils';

export interface MappedCatalogItem {
  remoteKey: string;
  remoteVersion: bigint;
  title: string;
  itemType: string;
  abstract?: string;
  year?: number;
  doi?: string;
  citationKey?: string;
  publicationTitle?: string;
  publicationDate?: string;
  journalAbbreviation?: string;
  publisher?: string;
  place?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  series?: string;
  seriesTitle?: string;
  seriesText?: string;
  seriesNumber?: string;
  issn?: string;
  isbn?: string;
  url?: string;
  language?: string;
  rights?: string;
  archive?: string;
  archiveLocation?: string;
  libraryCatalog?: string;
  callNumber?: string;
  extra?: string;
  creators: Array<{
    creatorType: string;
    firstName?: string;
    lastName?: string;
    name?: string;
    sortOrder: number;
  }>;
  tags: Array<{
    name: string;
    type: string;
  }>;
  collectionKeys: string[];
  rawPayload: Record<string, any>;
  extraFields: Record<string, any>;
}

export interface MappedCollection {
  remoteKey: string;
  remoteVersion: bigint;
  name: string;
  parentRemoteKey?: string;
  rawPayload: Record<string, any>;
}

export interface MappedAttachment {
  remoteKey: string;
  remoteVersion: bigint;
  parentItemKey: string;
  filename: string;
  url?: string;
  mimeType: string;
  fileHash?: string;
  attachmentType: string;
  rawPayload: Record<string, any>;
}

export interface MappedNote {
  remoteKey: string;
  remoteVersion: bigint;
  parentItemKey?: string;
  contentHtml: string;
  tags: string[];
  rawPayload: Record<string, any>;
}

export interface MappedAnnotation {
  remoteKey: string;
  remoteVersion: bigint;
  parentAttachmentKey: string;
  annotationType: string;
  pageIndex: number;
  quote?: string;
  comment?: string;
  color?: string;
  geometry?: any;
  rawPayload: Record<string, any>;
}

@Injectable()
export class ZoteroMapper {
  private readonly knownItemFields = new Set([
    'key',
    'version',
    'itemType',
    'title',
    'creators',
    'abstractNote',
    'publicationTitle',
    'journalAbbreviation',
    'publisher',
    'place',
    'volume',
    'issue',
    'pages',
    'series',
    'seriesTitle',
    'seriesText',
    'seriesNumber',
    'citationKey',
    'date',
    'DOI',
    'doi',
    'ISSN',
    'ISBN',
    'url',
    'language',
    'rights',
    'archive',
    'archiveLocation',
    'libraryCatalog',
    'callNumber',
    'extra',
    'tags',
    'collections',
    'relations',
    'dateAdded',
    'dateModified',
  ]);

  /**
   * Maps a raw Zotero Item payload to canonical CatalogItem structure.
   */
  mapZoteroItem(rawItem: any): MappedCatalogItem {
    const data = rawItem.data || rawItem;
    const remoteKey = String(rawItem.key || data.key);
    const remoteVersion = BigInt(rawItem.version || data.version || 0);

    // Extract year from date string (e.g. "2017", "2017-06-12", "June 2017")
    let year: number | undefined;
    if (data.date) {
      const match = String(data.date).match(/\b(19|20)\d{2}\b/);
      if (match) {
        year = parseInt(match[0], 10);
      }
    }

    const doi = this.extractDoi(data);

    // Extract citation key from extra if available
    let citationKey: string | undefined;
    if (data.citationKey) {
      citationKey = String(data.citationKey).trim() || undefined;
    }
    if (!citationKey && data.extra) {
      const match = String(data.extra).match(/Citation Key:\s*([^\s\n\r]+)/i);
      if (match) {
        citationKey = match[1];
      }
    }

    // Map creators
    const creators = Array.isArray(data.creators)
      ? data.creators.map((c: any, index: number) => ({
          creatorType: c.creatorType || 'author',
          firstName: c.firstName,
          lastName: c.lastName,
          name:
            c.name ||
            (c.lastName
              ? `${c.firstName ? c.firstName + ' ' : ''}${c.lastName}`
              : 'Unknown'),
          sortOrder: index,
        }))
      : [];

    // Map tags
    const tags = Array.isArray(data.tags)
      ? data.tags.map((t: any) => ({
          name: typeof t === 'string' ? t : t.tag,
          type: t.type === 1 ? 'automatic' : 'manual',
        }))
      : [];

    // Map collection keys
    const collectionKeys = Array.isArray(data.collections)
      ? data.collections.map(String)
      : [];

    // Extract unknown / extra properties for 100% roundtrip preservation
    const extraFields: Record<string, any> = this.parseExtra(data.extra);
    for (const [key, value] of Object.entries(data)) {
      if (!this.knownItemFields.has(key)) {
        extraFields[key] = value;
      }
    }

    return {
      remoteKey,
      remoteVersion,
      title: data.title || 'Untitled Document',
      itemType: data.itemType || 'journalArticle',
      abstract: data.abstractNote,
      year,
      doi,
      citationKey,
      publicationTitle: data.publicationTitle || data.proceedingsTitle,
      publicationDate: data.date,
      journalAbbreviation: data.journalAbbreviation,
      publisher: data.publisher,
      place: data.place,
      volume: data.volume,
      issue: data.issue,
      pages: data.pages,
      series: data.series,
      seriesTitle: data.seriesTitle,
      seriesText: data.seriesText,
      seriesNumber: data.seriesNumber,
      issn: data.ISSN,
      isbn: data.ISBN,
      url: data.url,
      language: data.language,
      rights: data.rights,
      archive: data.archive,
      archiveLocation: data.archiveLocation,
      libraryCatalog: data.libraryCatalog,
      callNumber: data.callNumber,
      extra: typeof data.extra === 'string' ? data.extra : undefined,
      creators,
      tags,
      collectionKeys,
      rawPayload: data,
      extraFields,
    };
  }

  private extractDoi(data: Record<string, any>): string | undefined {
    const candidates = [
      data.DOI,
      data.doi,
      data.url,
      ...(typeof data.extra === 'string' ? [data.extra] : []),
    ];

    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const match = candidate.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/);
      const normalized = normalizeDoi(match?.[0] || candidate);
      if (normalized) return normalized;
    }

    return undefined;
  }

  private parseExtra(extra: unknown): Record<string, any> {
    if (typeof extra !== 'string' || !extra.trim()) return {};

    const fields: Record<string, any> = {};
    for (const line of extra.split(/\r?\n/)) {
      const match = line.match(/^\s*([^:]+):\s*(.+?)\s*$/);
      if (!match) continue;
      const key = match[1].trim();
      const value = match[2].trim();
      if (!key || !value) continue;
      const normalizedKey = key.replace(/\s+/g, '').toLowerCase();
      if (normalizedKey === 'citationkey') fields.citationKey = value;
      else if (normalizedKey === 'doi') fields.doi = normalizeDoi(value) || value;
      else if (normalizedKey === 'pmid') fields.pmid = value;
      else if (normalizedKey === 'pmcid') fields.pmcid = value;
      else if (normalizedKey === 'arxiv' || normalizedKey === 'arxivid') {
        fields.arxivId = value.split(/\s+/)[0].replace(/^arxiv:/i, '');
      } else {
        fields[key] = value;
      }
    }

    const arxivMatch = extra.match(/arXiv:\s*([\d.]+v?\d*)\s*(?:\[([^\]]+)\])?/i);
    if (arxivMatch) {
      fields.arxivId ||= arxivMatch[1];
      if (arxivMatch[2]) {
        fields.arxivCategories = arxivMatch[2]
          .split(/[,\s]+/)
          .map((value) => value.trim())
          .filter(Boolean);
      }
    }

    return fields;
  }

  /**
   * Maps a raw Zotero Collection payload to canonical Collection structure.
   */
  mapZoteroCollection(rawCollection: any): MappedCollection {
    const data = rawCollection.data || rawCollection;
    const remoteKey = String(rawCollection.key || data.key);
    const remoteVersion = BigInt(rawCollection.version || data.version || 0);

    return {
      remoteKey,
      remoteVersion,
      name: data.name || 'Untitled Collection',
      parentRemoteKey: data.parentCollection
        ? String(data.parentCollection)
        : undefined,
      rawPayload: data,
    };
  }

  /**
   * Maps a raw Zotero Attachment payload.
   */
  mapZoteroAttachment(rawAttachment: any): MappedAttachment {
    const data = rawAttachment.data || rawAttachment;
    const remoteKey = String(rawAttachment.key || data.key);
    const remoteVersion = BigInt(rawAttachment.version || data.version || 0);

    return {
      remoteKey,
      remoteVersion,
      parentItemKey: String(data.parentItem),
      filename: data.filename || data.title || 'attachment.pdf',
      url: data.url,
      mimeType: data.contentType || 'application/pdf',
      fileHash: data.md5,
      attachmentType:
        data.contentType === 'application/pdf'
          ? 'primary_pdf'
          : 'supplementary',
      rawPayload: data,
    };
  }

  /**
   * Maps a raw Zotero Note payload.
   */
  mapZoteroNote(rawNote: any): MappedNote {
    const data = rawNote.data || rawNote;
    const remoteKey = String(rawNote.key || data.key);
    const remoteVersion = BigInt(rawNote.version || data.version || 0);

    const tags = Array.isArray(data.tags)
      ? data.tags.map((t: any) => (typeof t === 'string' ? t : t.tag))
      : [];

    return {
      remoteKey,
      remoteVersion,
      parentItemKey: data.parentItem ? String(data.parentItem) : undefined,
      contentHtml: data.note || '',
      tags,
      rawPayload: data,
    };
  }

  /**
   * Maps a raw Zotero Annotation payload.
   */
  mapZoteroAnnotation(rawAnnotation: any): MappedAnnotation {
    const data = rawAnnotation.data || rawAnnotation;
    const remoteKey = String(rawAnnotation.key || data.key);
    const remoteVersion = BigInt(rawAnnotation.version || data.version || 0);

    const pageIndex =
      data.annotationPosition?.pageIndex ??
      (data.annotationPageLabel
        ? parseInt(data.annotationPageLabel, 10) - 1
        : 0);

    return {
      remoteKey,
      remoteVersion,
      parentAttachmentKey: String(data.parentItem),
      annotationType: data.annotationType || 'highlight',
      pageIndex: Math.max(pageIndex, 0),
      quote: data.annotationText,
      comment: data.annotationComment,
      color: data.annotationColor || '#ffd400',
      geometry: data.annotationPosition,
      rawPayload: data,
    };
  }

  /**
   * Maps a canonical CatalogItem to Zotero API payload format.
   */
  mapToZoteroItem(
    item: Record<string, any>,
    basePayload: Record<string, any> = {},
  ): Record<string, any> {
    const payload: Record<string, any> = {
      ...basePayload,
      itemType: item.itemType || basePayload.itemType || 'journalArticle',
      title: item.title || basePayload.title || 'Untitled',
      abstractNote:
        item.abstract !== undefined ? item.abstract : basePayload.abstractNote,
      publicationTitle:
        item.publicationTitle !== undefined
          ? item.publicationTitle
          : basePayload.publicationTitle,
      volume: item.volume !== undefined ? item.volume : basePayload.volume,
      issue: item.issue !== undefined ? item.issue : basePayload.issue,
      pages: item.pages !== undefined ? item.pages : basePayload.pages,
      DOI: item.doi !== undefined ? item.doi : basePayload.DOI,
      url: item.url !== undefined ? item.url : basePayload.url,
      ISSN: item.issn !== undefined ? item.issn : basePayload.ISSN,
      ISBN: item.isbn !== undefined ? item.isbn : basePayload.ISBN,
    };

    if (item.year) {
      payload.date = String(item.year);
    }

    if (Array.isArray(item.tags)) {
      payload.tags = item.tags.map((t: any) => ({
        tag: typeof t === 'string' ? t : t.name || t.tag,
        type: 0,
      }));
    }

    return payload;
  }
}
