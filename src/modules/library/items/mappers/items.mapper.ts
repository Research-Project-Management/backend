import { getFileContentPath } from '@/modules/storage/storage.port';
import { ITEM_COLUMN_METADATA_FIELDS } from '../constants/items.constants';
import { cleanAbstractText } from '../utils/items.utils';

export class ItemsMapper {
  /**
   * Normalizes a single Item record or payload to the canonical domain shape.
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

    // Populate openAccessPdfUrl from fileUrl if fileUrl is an external link
    if (
      !it.openAccessPdfUrl &&
      it.fileUrl &&
      typeof it.fileUrl === 'string' &&
      /^https?:\/\//i.test(it.fileUrl)
    ) {
      it.openAccessPdfUrl = it.fileUrl;
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
      // If fileUrl is pointing to an external PDF or OpenAccess PDF, keep it; otherwise clear landing page
      const isPdfLink =
        /\.pdf(?:[?#]|$)/i.test(it.fileUrl) ||
        /\/pdf\//i.test(it.fileUrl) ||
        (it.openAccessPdfUrl && it.fileUrl === it.openAccessPdfUrl);
      if (!isPdfLink) {
        it.fileUrl = it.openAccessPdfUrl || null;
      }
    } else if (!it.fileUrl) {
      it.fileUrl = it.openAccessPdfUrl || null;
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
      delete extraFields._rawExtra;
    } else if (
      typeof it.extra === 'string' &&
      it.extra.trim().startsWith('{')
    ) {
      const lines: string[] = [];
      for (const [k, v] of Object.entries(extraFields)) {
        if (
          v !== null &&
          v !== undefined &&
          v !== '' &&
          !ITEM_COLUMN_METADATA_FIELDS.has(k)
        ) {
          lines.push(`${k}: ${String(v)}`);
        }
      }
      it.extra = lines.length > 0 ? lines.join('\n') : '';
    }

    // Explicit projection of known academic fields from extraFields (legacy fallback for old records
    // that were stored before dedicated DB columns existed).
    // New records will have these as proper DB columns — these fallbacks handle pre-migration data.
    if (it.citationCount === undefined || it.citationCount === null) {
      it.citationCount = extraFields.citationCount ?? null;
    }
    if (it.referenceCount === undefined || it.referenceCount === null) {
      it.referenceCount = extraFields.referenceCount ?? null;
    }
    if (!it.openAccessPdfUrl)
      it.openAccessPdfUrl = extraFields.openAccessPdfUrl ?? null;
    if (!it.arxivId)
      it.arxivId = extraFields.arxivId ?? extraFields.archiveId ?? null;
    if (!it.seriesNumber) it.seriesNumber = extraFields.seriesNumber ?? null;
    if (!it.rights) {
      it.rights =
        it.license ?? extraFields.rights ?? extraFields.license ?? null;
    }
    if (!it.license) {
      it.license =
        it.rights ?? extraFields.license ?? extraFields.rights ?? null;
    }

    if (it.abstract || extraFields.abstract || extraFields.abstractNote) {
      const rawAbstract =
        it.abstract || extraFields.abstract || extraFields.abstractNote;
      it.abstract = cleanAbstractText(rawAbstract) ?? (it.abstract || null);
    }

    // Legacy cleanup: If callNumber has arXiv:xxx, clean it and ensure it.arxivId is populated
    if (
      it.callNumber &&
      /^arxiv:\s*\d{4}\.\d{4,5}/i.test(String(it.callNumber))
    ) {
      if (!it.arxivId) {
        it.arxivId = String(it.callNumber)
          .replace(/^arxiv:\s*/i, '')
          .trim();
      }
      it.callNumber = null;
    }

    // Ensure native Zotero Extra format: arXiv:<id> [<primaryCategory>]
    // And ensure clean archiveId for preprints (arXiv:<id> without category)
    if (it.arxivId || it.archiveId) {
      const rawId = String(it.arxivId || it.archiveId);
      const cleanArxivId = rawId
        .replace(/^arxiv:\s*/i, '')
        .replace(/\s*\[.*?\]\s*$/, '')
        .trim();
      it.arxivId = cleanArxivId;
      const canonicalCleanId = cleanArxivId.replace(/v\d+$/i, '');
      if (it.itemType === 'preprint') {
        it.archiveId = `arXiv:${canonicalCleanId}`;
        it.repository = it.repository || 'arXiv';
      }

      const existingExtra = typeof it.extra === 'string' ? it.extra.trim() : '';
      if (!existingExtra.toLowerCase().includes('arxiv:')) {
        const primaryCat =
          extraFields.primaryCategory ||
          (Array.isArray(it.tags)
            ? it.tags.find((t: any) =>
                /^[a-z-]+(\.[a-z-]+)?$/i.test(String(t?.name || t)),
              )
            : undefined);
        const catStr = primaryCat
          ? typeof primaryCat === 'object'
            ? primaryCat.name
            : primaryCat
          : undefined;
        const arxivLine = catStr
          ? `arXiv:${canonicalCleanId} [${catStr}]`
          : `arXiv:${canonicalCleanId}`;
        it.extra = existingExtra ? `${arxivLine}\n${existingExtra}` : arxivLine;
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

    // 9. Harmonize Publication Venue, Dates & Field Aliases (Zotero Parity)
    it.journal = it.journal || it.publicationTitle || '';
    it.publicationTitle = it.publicationTitle || it.journal || '';
    it.publicationDate = it.publicationDate || (it.year ? String(it.year) : '');
    it.date = it.date || it.publicationDate || (it.year ? String(it.year) : '');
    it.abstractNote = it.abstractNote || it.abstract || '';
    it.abstract = it.abstract || it.abstractNote || '';
    it.journalAbbreviation = it.journalAbbreviation || it.journalAbbr || '';
    it.journalAbbr = it.journalAbbr || it.journalAbbreviation || '';
    it.archiveId =
      it.archiveId ||
      (it.arxivId
        ? it.itemType === 'preprint'
          ? `arXiv:${String(it.arxivId)
              .replace(/^arxiv:\s*/i, '')
              .replace(/\s*\[.*?\]\s*$/, '')
              .replace(/v\d+$/i, '')}`
          : it.arxivId
        : '');

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
    if (
      !it.arxivId &&
      (it.extraFields?.arxivId ||
        it.extraFields?.archiveId ||
        it.extraFields?.archiveID)
    ) {
      it.arxivId = String(
        it.extraFields.arxivId ||
          it.extraFields.archiveId ||
          it.extraFields.archiveID,
      );
    }
    if (!it.doi && (it.extraFields?.doi || it.extraFields?.DOI)) {
      it.doi = String(it.extraFields.doi || it.extraFields.DOI);
    }
    if (!it.isbn && (it.extraFields?.isbn || it.extraFields?.ISBN)) {
      it.isbn = String(it.extraFields.isbn || it.extraFields.ISBN);
    }
    if (!it.issn && (it.extraFields?.issn || it.extraFields?.ISSN)) {
      it.issn = String(it.extraFields.issn || it.extraFields.ISSN);
    }
    if (!it.pmid && (it.extraFields?.pmid || it.extraFields?.PMID)) {
      it.pmid = String(it.extraFields.pmid || it.extraFields.PMID);
    }
    if (!it.pmcid && (it.extraFields?.pmcid || it.extraFields?.PMCID)) {
      it.pmcid = String(it.extraFields.pmcid || it.extraFields.PMCID);
    }

    // Bidirectional harmonization for Zotero schema v42 uppercase & Prisma DB columns
    const canonicalDoi = it.doi || it.DOI || '';
    it.doi = canonicalDoi;
    it.DOI = canonicalDoi;

    const canonicalIsbn = it.isbn || it.ISBN || '';
    it.isbn = canonicalIsbn;
    it.ISBN = canonicalIsbn;

    const canonicalIssn = it.issn || it.ISSN || '';
    it.issn = canonicalIssn;
    it.ISSN = canonicalIssn;

    const canonicalPmid = it.pmid || it.PMID || '';
    it.pmid = canonicalPmid;
    it.PMID = canonicalPmid;

    const canonicalPmcid = it.pmcid || it.PMCID || '';
    it.pmcid = canonicalPmcid;
    it.PMCID = canonicalPmcid;

    const canonicalArxivId = it.arxivId || it.archiveId || it.archiveID || '';
    const cleanArxiv = canonicalArxivId
      ? String(canonicalArxivId)
          .replace(/^arxiv:\s*/i, '')
          .replace(/\s*\[.*?\]\s*$/, '')
          .trim()
      : '';
    it.arxivId = cleanArxiv;
    it.archiveId = cleanArxiv
      ? it.itemType === 'preprint'
        ? `arXiv:${cleanArxiv.replace(/v\d+$/i, '')}`
        : cleanArxiv
      : it.archiveId || '';
    it.archiveID = it.archiveID || it.archiveId;
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
   * Normalizes an array of Item records.
   */
  static toDomainList<T>(items: T[]): T[] {
    if (!Array.isArray(items)) return items;
    return items.map((item) => ItemsMapper.toDomain(item));
  }

  /**
   * Projects user state (readStatus, rating, lastReadAt) to top level of domain item.
   * Matches specific userId if provided, falling back to the first available user state record.
   */
  static mapFlattenedState<T extends Record<string, any>>(
    item: T | null | undefined,
    userId?: string,
  ):
    | (T & { readStatus: string; rating: number; lastReadAt: string | null })
    | null {
    if (!item) return null;
    const normalized = ItemsMapper.toDomain(item) as any;
    let userState: any = undefined;
    if (
      Array.isArray(normalized.userStates) &&
      normalized.userStates.length > 0
    ) {
      userState = userId
        ? normalized.userStates.find((u: any) => u.userId === userId) ||
          normalized.userStates[0]
        : normalized.userStates[0];
    }
    const { userStates: _userStates, ...rest } = normalized;
    return {
      ...rest,
      readStatus: userState?.readStatus ?? 'unread',
      rating: userState?.rating ?? 0,
      lastReadAt: userState?.lastReadAt
        ? userState.lastReadAt instanceof Date
          ? userState.lastReadAt.toISOString()
          : String(userState.lastReadAt)
        : null,
    };
  }
}
