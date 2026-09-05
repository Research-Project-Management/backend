import { getFileContentPath } from '@/modules/storage/storage.port';

export class ItemsMapper {
  /**
   * Normalizes a single CatalogItem record or payload to the canonical domain shape.
   * Resolves primary PDF attachment priority and ensures all internal file attachments
   * use the authenticated canonical streaming content URL (/api/files/:fileId/content).
   */
  static toDomain<T>(item: T): T {
    if (!item || typeof item !== 'object') return item;
    const it = { ...(item as any) };

    if (Array.isArray(it.attachments)) {
      it.attachments = it.attachments.map((att: any) => {
        if (!att || typeof att !== 'object') return att;
        const normalizedAtt = { ...att };
        if (normalizedAtt.fileId) {
          const canonicalUrl = getFileContentPath(normalizedAtt.fileId);
          normalizedAtt.url = canonicalUrl;
          if (Array.isArray(normalizedAtt.revisions)) {
            normalizedAtt.revisions = normalizedAtt.revisions.map(
              (rev: any) => ({
                ...rev,
                url: canonicalUrl,
              }),
            );
          }
        }
        return normalizedAtt;
      });
    }

    // 1. Find primary PDF attachment according to strict priority
    let primaryPdfAttachment: any = null;
    if (Array.isArray(it.attachments) && it.attachments.length > 0) {
      primaryPdfAttachment =
        it.attachments.find(
          (a: any) => a?.attachmentType === 'primary_pdf' && a?.fileId,
        ) ||
        it.attachments.find(
          (a: any) => a?.mimeType === 'application/pdf' && a?.fileId,
        ) ||
        it.attachments.find(
          (a: any) =>
            a?.fileId &&
            typeof a?.filename === 'string' &&
            a.filename.toLowerCase().endsWith('.pdf'),
        );
    }

    if (primaryPdfAttachment?.fileId) {
      it.fileUrl = getFileContentPath(primaryPdfAttachment.fileId);
    } else if (
      it.fileUrl &&
      typeof it.fileUrl === 'string' &&
      it.fileUrl.startsWith('/api/files/') &&
      !it.fileUrl.includes('/r2/') &&
      !it.fileUrl.endsWith('/content')
    ) {
      // Legacy metadata URL without attachments array — convert to canonical content URL
      const match = it.fileUrl.match(/^\/api\/files\/([^/?#]+)$/);
      if (match && match[1]) {
        it.fileUrl = getFileContentPath(match[1]);
      }
    } else if (
      it.fileUrl &&
      typeof it.fileUrl === 'string' &&
      !it.fileUrl.endsWith('/content') &&
      !it.fileUrl.startsWith('/api/files/')
    ) {
      // If fileUrl is pointing to external URL or landing page, clear it so it doesn't break PDF viewer
      it.fileUrl = null;
    } else if (!it.fileUrl) {
      it.fileUrl = null;
    }

    // 2. Canonical ItemType projection
    it.itemType = it.itemType || it.type || 'journalArticle';

    // 3. Unpack ExtraFields
    let extraFields: Record<string, any> = {};
    if (it.extraFields && typeof it.extraFields === 'object') {
      extraFields = { ...it.extraFields };
    } else if (
      typeof it.extra === 'string' &&
      it.extra.trim().startsWith('{')
    ) {
      try {
        extraFields = JSON.parse(it.extra);
      } catch {
        // Not valid json, ignore
      }
    } else if (typeof it.extra === 'string' && it.extra.trim()) {
      // Parse plain text key-value lines (e.g. Zotero style "Citations: 23526")
      const lines = it.extra.split(/\r?\n/);
      for (const line of lines) {
        const match = line.match(/^([a-zA-Z0-9_\s]+):\s*(.+)$/);
        if (match) {
          const rawKey = match[1].trim();
          const val = match[2].trim();
          if (/^citations?(\s*count)?$/i.test(rawKey)) {
            const num = parseInt(val.replace(/,/g, ''), 10);
            if (!isNaN(num)) extraFields.citationCount = num;
          }
        }
      }
    }
    it.extraFields = extraFields;

    // If _rawExtra key is present, it means the original extra was plain text (e.g. Zotero format).
    // Restore it.extra to the original plain text so consumers (export, FE) can access it.
    if (typeof extraFields._rawExtra === 'string') {
      it.extra = extraFields._rawExtra;
    }

    // Project extra fields to top-level if not already set
    for (const [k, v] of Object.entries(extraFields)) {
      if (k === '_rawExtra') continue; // Do not pollute top-level with internal key
      if (it[k] === undefined || it[k] === null || it[k] === '') {
        it[k] = v;
      }
    }

    // Project lastReadAt from userStates if present and not already top-level
    if (
      !it.lastReadAt &&
      Array.isArray(it.userStates) &&
      it.userStates.length > 0
    ) {
      const activeState = it.userStates.find((u: any) => u?.lastReadAt);
      if (activeState?.lastReadAt) {
        it.lastReadAt =
          activeState.lastReadAt instanceof Date
            ? activeState.lastReadAt.toISOString()
            : activeState.lastReadAt;
      }
    }

    // 4. Canonical Creators Projection
    if (Array.isArray(it.contributors) && it.contributors.length > 0) {
      it.creators = it.contributors.map((c: any, idx: number) => ({
        id: c.id,
        orderIndex: c.orderIndex ?? idx,
        creatorType: c.creatorType || 'author',
        firstName: c.firstName || undefined,
        lastName: c.lastName || undefined,
        fullName:
          c.fullName ||
          [c.firstName, c.lastName].filter(Boolean).join(' ') ||
          c.name ||
          '',
        name:
          c.fullName ||
          [c.firstName, c.lastName].filter(Boolean).join(' ') ||
          c.name ||
          '',
      }));
    } else if (Array.isArray(it.creators) && it.creators.length > 0) {
      it.creators = it.creators.map((c: any, idx: number) => ({
        id: c.id,
        orderIndex: c.orderIndex ?? idx,
        creatorType: c.creatorType || 'author',
        firstName: c.firstName || undefined,
        lastName: c.lastName || undefined,
        fullName:
          c.fullName ||
          [c.firstName, c.lastName].filter(Boolean).join(' ') ||
          c.name ||
          '',
        name:
          c.fullName ||
          [c.firstName, c.lastName].filter(Boolean).join(' ') ||
          c.name ||
          '',
      }));
    } else if (Array.isArray(it.authors) && it.authors.length > 0) {
      it.creators = it.authors.map((name: string, idx: number) => ({
        orderIndex: idx,
        creatorType: 'author',
        fullName: name,
        name,
      }));
    } else {
      it.creators = [];
    }

    // 5. Canonical Authors Projection (string[] for fast UI display)
    if (!it.authors || !Array.isArray(it.authors) || it.authors.length === 0) {
      const authorCreators = it.creators.filter(
        (creator: any) => creator.creatorType === 'author',
      );
      it.authors = (authorCreators.length > 0 ? authorCreators : it.creators)
        .map(
          (c: any) =>
            c.fullName ||
            c.name ||
            [c.firstName, c.lastName].filter(Boolean).join(' '),
        )
        .filter(Boolean);
    }
    it.editors = it.creators
      .filter((creator: any) => creator.creatorType === 'editor')
      .map((creator: any) => creator.fullName || creator.name)
      .filter(Boolean);

    // 6. Canonical Tags & Labels Projection
    if (Array.isArray(it.itemTags) && it.itemTags.length > 0) {
      const tagNames = it.itemTags
        .map((t: any) => t.tag?.name || t.name)
        .filter(Boolean);
      it.tags = tagNames;
      it.labels = tagNames;
      it.keywords = tagNames;
    } else {
      it.tags = it.tags || it.labels || [];
      it.labels = it.labels || it.tags || [];
      it.keywords = it.keywords || it.tags || it.labels || [];
    }

    // 7. Canonical Collection Targeting Projection
    if (Array.isArray(it.collectionItems) && it.collectionItems.length > 0) {
      it.collectionId =
        it.collectionId ||
        it.collectionItems[0].collectionId ||
        it.collectionItems[0].collection?.id ||
        null;
      it.collectionIds = it.collectionItems
        .map((ci: any) => ci.collectionId || ci.collection?.id)
        .filter(Boolean);
      it.collections = it.collectionItems
        .map((ci: any) => ci.collection)
        .filter(Boolean);
    } else {
      it.collectionId = it.collectionId || null;
      it.collectionIds = it.collectionIds || [];
      it.collections = it.collections || [];
    }

    // 8. Canonical Notes Projection (unifying notesList -> notes)
    if (Array.isArray(it.notesList)) {
      it.notes = it.notesList.map((n: any) => ({
        ...n,
        content: n.content || n.contentMd || '',
        contentMd: n.contentMd || n.content || '',
      }));
    } else if (Array.isArray(it.notes)) {
      it.notes = it.notes.map((n: any) => ({
        ...n,
        content: n.content || n.contentMd || '',
        contentMd: n.contentMd || n.content || '',
      }));
    } else {
      it.notes = [];
    }

    // 9. Harmonize Publication Venue & Dates
    it.journal = it.journal || it.publicationTitle || '';
    it.publicationTitle = it.publicationTitle || it.journal || '';
    it.publicationDate = it.publicationDate || (it.year ? String(it.year) : '');
    it.date = it.publicationDate || (it.year ? String(it.year) : '');

    // 10. Identifier Projections (DOI, arXiv, PMID, PMCID, ISBN, ISSN)
    if (Array.isArray(it.identifiers)) {
      for (const ident of it.identifiers) {
        const type = (ident.type || ident.identifierType || '').toLowerCase();
        if (type === 'arxiv' && !it.arxivId) it.arxivId = ident.value;
        if (type === 'doi' && !it.doi) it.doi = ident.value;
        if (type === 'pmid' && !it.pmid) it.pmid = ident.value;
        if (type === 'pmcid' && !it.pmcid) it.pmcid = ident.value;
        if (type === 'isbn' && !it.isbn) it.isbn = ident.value;
        if (type === 'issn' && !it.issn) it.issn = ident.value;
      }
    }
    if (!it.arxivId && it.extraFields?.arxivId) {
      it.arxivId = String(it.extraFields.arxivId);
    }
    if (!it.doi && it.extraFields?.doi) {
      it.doi = String(it.extraFields.doi);
    }
    if (!Array.isArray(it.identifiers) || it.identifiers.length === 0) {
      const generatedIdents: any[] = [];
      if (it.doi) {
        generatedIdents.push({
          type: 'doi',
          value: it.doi,
          canonicalUri: `https://doi.org/${it.doi}`,
        });
      }
      if (it.arxivId) {
        generatedIdents.push({
          type: 'arxiv',
          value: it.arxivId,
          canonicalUri: `https://arxiv.org/abs/${it.arxivId}`,
        });
      }
      if (it.pmid) {
        generatedIdents.push({
          type: 'pmid',
          value: it.pmid,
          canonicalUri: `https://pubmed.ncbi.nlm.nih.gov/${it.pmid}/`,
        });
      }
      if (it.pmcid) {
        generatedIdents.push({
          type: 'pmcid',
          value: it.pmcid,
          canonicalUri: `https://pmc.ncbi.nlm.nih.gov/articles/${it.pmcid}/`,
        });
      }
      if (it.isbn) {
        generatedIdents.push({
          type: 'isbn',
          value: it.isbn,
          canonicalUri: `urn:isbn:${it.isbn}`,
        });
      }
      if (it.issn) {
        generatedIdents.push({
          type: 'issn',
          value: it.issn,
          canonicalUri: `urn:issn:${it.issn}`,
        });
      }
      it.identifiers = generatedIdents;
    }

    // 11. Primary File Metadata Projection
    if (primaryPdfAttachment) {
      it.filename = it.filename || primaryPdfAttachment.filename || '';
      it.mimeType =
        it.mimeType || primaryPdfAttachment.mimeType || 'application/pdf';
      it.size = it.size || primaryPdfAttachment.size || 0;
    }

    // 12. Construct primaryFile object (FE schema: primaryFileSchema)
    // Previously only flat fields were set; the nested object was never built.
    if (primaryPdfAttachment?.fileId) {
      it.primaryFile = {
        fileId: primaryPdfAttachment.fileId,
        filename: it.filename || primaryPdfAttachment.filename || '',
        url: it.fileUrl || '',
        size: it.size || primaryPdfAttachment.size || 0,
        mimeType:
          it.mimeType || primaryPdfAttachment.mimeType || 'application/pdf',
      };
    } else if (it.fileUrl) {
      it.primaryFile = {
        fileId: null,
        filename: it.filename || '',
        url: it.fileUrl,
        size: it.size || 0,
        mimeType: it.mimeType || 'application/pdf',
      };
    } else {
      it.primaryFile = it.primaryFile ?? null;
    }

    return it as T;
  }

  /**
   * Normalizes an array of CatalogItem records.
   */
  static toDomainList<T>(items: T[]): T[] {
    if (!Array.isArray(items)) return items;
    return items.map((item) => ItemsMapper.toDomain(item));
  }
}

export const CatalogItemMapper = ItemsMapper;
export type CatalogItemMapper = ItemsMapper;
