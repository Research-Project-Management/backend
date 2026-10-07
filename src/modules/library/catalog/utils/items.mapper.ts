import { getFileContentPath } from '@/modules/storage/storage.port';
import {
  ITEM_COLUMN_METADATA_FIELDS,
  TYPE_SPECIFIC_EXTRA_FIELDS,
} from '../types/items.constants';
import { BASE_FIELD_MAPPINGS } from '../../shared-kernel/types/schema.constants';
import {
  cleanAbstractText,
  cleanCommentText,
  splitAuthorString,
} from '../../shared-kernel/utils/bibliographic.utils';
import {
  resolveCanonicalArxivCategory,
  normalizeTags,
  cleanSingleTag,
} from '../../shared-kernel/utils/tag.utils';

export class ItemMapper {
  /**
   * Normalizes a single Item record or payload to the canonical domain shape.
   * Resolves primary PDF attachment priority and ensures all internal file attachments
   * use the authenticated canonical streaming content URL (/api/files/:fileId/content).
   */
  static toDomain<T>(item: T): T {
    if (!item || typeof item !== 'object') return item;
    const it = { ...(item as any) };

    if (!it.userStates && Array.isArray(it.states)) {
      it.userStates = it.states;
    }

    // 0. Unpack metadata from PostgreSQL JsonB column if present
    if (it.metadata) {
      const metaObj =
        typeof it.metadata === 'object' && !Array.isArray(it.metadata)
          ? it.metadata
          : typeof it.metadata === 'string' &&
              it.metadata.trim().startsWith('{')
            ? (() => {
                try {
                  return JSON.parse(it.metadata);
                } catch {
                  return null;
                }
              })()
            : null;

      if (metaObj && typeof metaObj === 'object') {
        for (const [key, value] of Object.entries(metaObj)) {
          if (value !== undefined && value !== null && it[key] === undefined) {
            it[key] = value;
          }
        }
      }
    }

    if (Array.isArray(it.attachments)) {
      it.attachments = it.attachments.map((attachment: any) => {
        if (!attachment || typeof attachment !== 'object') return attachment;
        const normalizedAttachment = { ...attachment };
        const attachmentMetadata =
          typeof normalizedAttachment.metadata === 'object' &&
          normalizedAttachment.metadata !== null
            ? normalizedAttachment.metadata
            : {};
        normalizedAttachment.title =
          normalizedAttachment.title ||
          attachmentMetadata.title ||
          normalizedAttachment.filename ||
          '';

        if (normalizedAttachment.fileId) {
          const canonicalUrl = getFileContentPath(normalizedAttachment.fileId);
          normalizedAttachment.url = canonicalUrl;
          if (Array.isArray(normalizedAttachment.revisions)) {
            normalizedAttachment.revisions = normalizedAttachment.revisions.map(
              (revision: any) => ({
                ...revision,
                url: canonicalUrl,
              }),
            );
          }
        }
        return normalizedAttachment;
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
    it.type = it.type || it.itemType || 'journalArticle';

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
      const lines = it.extra.split(/\r?\n/);
      const remainingLines: string[] = [];
      const nonColumnFieldsSet = new Set(
        TYPE_SPECIFIC_EXTRA_FIELDS.map((f: string) => f.toLowerCase()),
      );

      for (const line of lines) {
        const match = line.match(/^([a-zA-Z0-9_\s]+):\s*(.+)$/);
        if (match) {
          const rawKey = match[1].trim();
          const val = match[2].trim();
          const camelKey = rawKey
            .replace(/\s+([a-zA-Z])/g, (_: string, c: string) =>
              c.toUpperCase(),
            )
            .replace(/^[A-Z]/, (c: string) => c.toLowerCase());
          const lowerKey = camelKey.toLowerCase();

          if (/^citations?(\s*count)?$/i.test(rawKey)) {
            const num = parseInt(val.replace(/,/g, ''), 10);
            if (!isNaN(num)) extraFields.citationCount = num;
          } else if (/^comments?$/i.test(rawKey)) {
            const cleaned = cleanCommentText(val);
            if (cleaned) extraFields.comment = cleaned;
          } else if (/^(numPages|numberOfPages|pageCount)$/i.test(camelKey)) {
            const num = parseInt(val, 10);
            const resolvedNum = isNaN(num) ? val : num;
            extraFields[camelKey] = resolvedNum;
            extraFields.numPages = resolvedNum;
            extraFields.numberOfPages = resolvedNum;
          } else if (
            nonColumnFieldsSet.has(lowerKey) ||
            ITEM_COLUMN_METADATA_FIELDS.has(camelKey)
          ) {
            let parsedVal: any = val;
            if (/^(true|false)$/i.test(val))
              parsedVal = val.toLowerCase() === 'true';
            else if (/^\d+$/.test(val)) parsedVal = parseInt(val, 10);
            extraFields[camelKey] = parsedVal;
          } else {
            remainingLines.push(line);
          }
        } else {
          remainingLines.push(line);
        }
      }
      it.extra = remainingLines.join('\n');
    }

    if (typeof extraFields._rawExtra === 'string') {
      it.extra = extraFields._rawExtra;
      delete extraFields._rawExtra;
    } else if (
      typeof it.extra === 'string' &&
      it.extra.trim().startsWith('{')
    ) {
      it.extra = '';
    }
    it.extraFields = extraFields;

    if (
      it.citationCount === undefined ||
      it.citationCount === null ||
      it.citationCount === 0 ||
      String(it.citationCount) === '0'
    ) {
      const parsedCit = extraFields.citationCount
        ? Number(extraFields.citationCount)
        : null;
      it.citationCount = parsedCit && parsedCit > 0 ? parsedCit : null;
    } else if (Number(it.citationCount) <= 0) {
      it.citationCount = null;
    }
    if (
      it.referenceCount === undefined ||
      it.referenceCount === null ||
      it.referenceCount === 0 ||
      String(it.referenceCount) === '0'
    ) {
      const parsedRef = extraFields.referenceCount
        ? Number(extraFields.referenceCount)
        : null;
      it.referenceCount = parsedRef && parsedRef > 0 ? parsedRef : null;
    } else if (Number(it.referenceCount) <= 0) {
      it.referenceCount = null;
    }
    if (!it.openAccessPdfUrl)
      it.openAccessPdfUrl = extraFields.openAccessPdfUrl ?? null;
    if (!it.arxivId)
      it.arxivId = extraFields.arxivId ?? extraFields.archiveId ?? null;
    if (!it.seriesNumber) it.seriesNumber = extraFields.seriesNumber ?? null;
    if (!it.edition && extraFields.edition)
      it.edition = String(extraFields.edition);
    if (!it.numPages && (extraFields.numPages || extraFields.numberOfPages)) {
      it.numPages = extraFields.numPages || extraFields.numberOfPages;
    }
    if (
      !it.numberOfPages &&
      (extraFields.numberOfPages || extraFields.numPages)
    ) {
      it.numberOfPages = extraFields.numberOfPages || extraFields.numPages;
    }
    if (
      !it.proceedingsTitle &&
      (extraFields.proceedingsTitle ||
        (it.itemType === 'conferencePaper' && it.publicationTitle))
    ) {
      it.proceedingsTitle = String(
        extraFields.proceedingsTitle || it.publicationTitle,
      );
    }
    if (
      !it.conferenceName &&
      extraFields.conferenceName &&
      extraFields.conferenceName !== it.proceedingsTitle &&
      extraFields.conferenceName !== it.publicationTitle
    ) {
      it.conferenceName = String(extraFields.conferenceName);
    }
    if (!it.institution && extraFields.institution) {
      it.institution = String(extraFields.institution);
    }
    if (!it.university && extraFields.university) {
      it.university = String(extraFields.university);
    }
    if (!it.reportNumber && extraFields.reportNumber) {
      it.reportNumber = String(extraFields.reportNumber);
    }
    if (!it.reportType && extraFields.reportType) {
      it.reportType = String(extraFields.reportType);
    }
    if (!it.thesisType && extraFields.thesisType) {
      it.thesisType = String(extraFields.thesisType);
    }
    if (!it.repository && extraFields.repository) {
      it.repository = String(extraFields.repository);
    }
    if (!it.country && extraFields.country) {
      it.country = String(extraFields.country);
    }
    if (!it.websiteTitle && extraFields.websiteTitle) {
      it.websiteTitle = String(extraFields.websiteTitle);
    }
    if (!it.rights) {
      it.rights =
        it.license ?? extraFields.rights ?? extraFields.license ?? null;
    }
    if (!it.license) {
      it.license =
        it.rights ?? extraFields.license ?? extraFields.rights ?? null;
    }

    for (const [k, v] of Object.entries(extraFields)) {
      if (
        v !== undefined &&
        v !== null &&
        it[k] === undefined &&
        k !== 'comment' &&
        k !== 'comments' &&
        k !== 'notes' &&
        k !== 'provenance' &&
        k !== '_rawExtra'
      ) {
        it[k] = v;
      }
    }

    if (it.abstract || extraFields.abstract || extraFields.abstractNote) {
      const rawAbstract =
        it.abstract || extraFields.abstract || extraFields.abstractNote;
      it.abstract = cleanAbstractText(rawAbstract) ?? (it.abstract || null);
    }
    it.abstractNote = it.abstract ?? null;
    if (
      it.year !== undefined &&
      it.year !== null &&
      (it.year === 0 || String(it.year) === '0' || Number(it.year) <= 0)
    ) {
      it.year = null;
    }
    it.date =
      it.date || it.publicationDate || (it.year ? String(it.year) : null);
    if (it.date === '0' || it.date === '0000') {
      it.date = null;
    }
    if (it.volume !== undefined && it.volume !== null) {
      const volStr = String(it.volume).trim();
      it.volume = volStr === '0' || volStr === '' ? null : volStr;
    }
    if (it.issue !== undefined && it.issue !== null) {
      const issueStr = String(it.issue).trim();
      it.issue = issueStr === '0' || issueStr === '' ? null : issueStr;
    }
    if (it.pages !== undefined && it.pages !== null) {
      const pagesStr = String(it.pages).trim();
      it.pages = pagesStr === '0' || pagesStr === '' ? null : pagesStr;
    }
    if (it.edition !== undefined && it.edition !== null) {
      const edStr = String(it.edition).trim();
      it.edition = edStr === '0' || edStr === '' ? null : edStr;
    }
    if (it.numPages !== undefined && it.numPages !== null) {
      const npStr = String(it.numPages).trim();
      it.numPages =
        npStr === '0' || npStr === ''
          ? null
          : isNaN(Number(npStr))
            ? npStr
            : Number(npStr) > 0
              ? Number(npStr)
              : null;
    }
    if (it.numberOfPages !== undefined && it.numberOfPages !== null) {
      const nopStr = String(it.numberOfPages).trim();
      it.numberOfPages =
        nopStr === '0' || nopStr === ''
          ? null
          : isNaN(Number(nopStr))
            ? nopStr
            : Number(nopStr) > 0
              ? Number(nopStr)
              : null;
    }

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
      const catStr = resolveCanonicalArxivCategory(
        canonicalCleanId,
        it.tags,
        extraFields,
        it,
      );

      if (!existingExtra.toLowerCase().includes('arxiv:')) {
        const arxivLine = catStr
          ? `arXiv: ${canonicalCleanId} [${catStr}]`
          : `arXiv: ${canonicalCleanId}`;
        it.extra = existingExtra ? `${arxivLine}\n${existingExtra}` : arxivLine;
      } else {
        it.extra = existingExtra.replace(
          /^arxiv:\s*([^\s[]+)(?:v\d+)?(?:\s*\[([^\]]+)\])?/im,
          (_: string, id: string, cat?: string) => {
            const canonicalId = id.replace(/v\d+$/i, '').trim();
            const existingCat = cat ? cat.trim() : '';
            const finalCat = existingCat || catStr;
            return finalCat
              ? `arXiv: ${canonicalId} [${finalCat}]`
              : `arXiv: ${canonicalId}`;
          },
        );
      }
    }

    if (Array.isArray(it.userStates) && it.userStates.length > 0) {
      const activeState = it.userStates[0];
      if (it.isStarred === undefined && activeState?.isStarred !== undefined) {
        it.isStarred = Boolean(activeState.isStarred);
      }
      if (it.readStatus === undefined && activeState?.readStatus) {
        it.readStatus = activeState.readStatus;
      }
      if (it.rating === undefined && activeState?.rating !== undefined) {
        it.rating = activeState.rating;
      }
      if (!it.lastReadAt) {
        const stateWithReadAt = it.userStates.find((u: any) => u?.lastReadAt);
        if (stateWithReadAt?.lastReadAt) {
          it.lastReadAt =
            stateWithReadAt.lastReadAt instanceof Date
              ? stateWithReadAt.lastReadAt.toISOString()
              : stateWithReadAt.lastReadAt;
        }
      }
    }

    // 4. Canonical Creators Projection
    if (Array.isArray(it.contributors) && it.contributors.length > 0) {
      it.creators = it.contributors.map((c: any, idx: number) => ({
        id: c.id,
        orderIndex: c.orderIndex ?? idx,
        creatorType: c.creatorType || 'author',
        fieldMode: c.fieldMode ?? 0,
        firstName: c.firstName || undefined,
        lastName: c.lastName || undefined,
        shortName: c.shortName || undefined,
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
        fieldMode: c.fieldMode ?? 0,
        firstName: c.firstName || undefined,
        lastName: c.lastName || undefined,
        shortName: c.shortName || undefined,
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
    if (Array.isArray(it.creators) && it.creators.length > 0) {
      const authorCreators = it.creators.filter(
        (creator: any) => (creator.creatorType || 'author') === 'author',
      );
      it.authors = (authorCreators.length > 0 ? authorCreators : it.creators)
        .map(
          (c: any) =>
            c.fullName ||
            c.name ||
            [c.firstName, c.lastName].filter(Boolean).join(' '),
        )
        .filter(Boolean);
    } else if (Array.isArray(it.authors) && it.authors.length > 0) {
      it.authors = it.authors.flatMap((a: string) => splitAuthorString(a));
    } else {
      it.authors = [];
    }
    it.editors = it.creators
      .filter((creator: any) => creator.creatorType === 'editor')
      .map((creator: any) => creator.fullName || creator.name)
      .filter(Boolean);

    // 6. Canonical Tags & Labels Projection
    if (Array.isArray(it.itemTags) && it.itemTags.length > 0) {
      const rawTagNames = it.itemTags
        .map((t: any) => t.tag?.name || t.name)
        .filter(Boolean);
      const tagNames = normalizeTags(rawTagNames);
      it.tags = tagNames;
      it.labels = tagNames;
      it.keywords = tagNames;

      const seenZotero = new Set<string>();
      it.zoteroTags = it.itemTags
        .map((t: any) => {
          const rawName = t.tag?.name || t.name || '';
          const cleanedName = cleanSingleTag(rawName);
          if (!cleanedName) return null;
          const lower = cleanedName.toLowerCase();
          if (seenZotero.has(lower)) return null;
          seenZotero.add(lower);
          return {
            tag: cleanedName,
            type:
              t.type === 'automatic' ||
              t.type === 1 ||
              (!t.type && t.tag?.type === 'automatic')
                ? 1
                : 0,
          };
        })
        .filter((zt: any): zt is NonNullable<typeof zt> => Boolean(zt));
    } else {
      const metadataObj =
        typeof it.metadata === 'object' && it.metadata !== null
          ? it.metadata
          : typeof it.metadata === 'string' &&
              it.metadata.trim().startsWith('{')
            ? (() => {
                try {
                  return JSON.parse(it.metadata);
                } catch {
                  return {};
                }
              })()
            : {};
      const rawTags =
        Array.isArray(it.tags) && it.tags.length > 0
          ? it.tags
          : Array.isArray(it.labels) && it.labels.length > 0
            ? it.labels
            : Array.isArray(it.keywords) && it.keywords.length > 0
              ? it.keywords
              : Array.isArray(metadataObj.tags) && metadataObj.tags.length > 0
                ? metadataObj.tags
                : Array.isArray(metadataObj.keywords) &&
                    metadataObj.keywords.length > 0
                  ? metadataObj.keywords
                  : Array.isArray(metadataObj.labels) &&
                      metadataObj.labels.length > 0
                    ? metadataObj.labels
                    : [];
      const tagNames = normalizeTags(rawTags);
      it.tags = tagNames;
      it.labels = tagNames;
      it.keywords = tagNames;

      const seenZotero = new Set<string>();
      it.zoteroTags = rawTags
        .map((t: any) => {
          const rawStr =
            typeof t === 'string'
              ? t
              : typeof t?.tag === 'string'
                ? t.tag
                : typeof t?.name === 'string'
                  ? t.name
                  : '';
          const cleanedName = cleanSingleTag(rawStr);
          if (!cleanedName) return null;
          const lower = cleanedName.toLowerCase();
          if (seenZotero.has(lower)) return null;
          seenZotero.add(lower);
          return {
            tag: cleanedName,
            type:
              typeof t === 'object' && t?.type !== undefined
                ? typeof t.type === 'number'
                  ? t.type
                  : t.type === 'automatic'
                    ? 1
                    : 0
                : 0,
          };
        })
        .filter((zt: any): zt is NonNullable<typeof zt> => Boolean(zt));
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

    // 8. Canonical Notes Projection
    if (Array.isArray(it.notesList) && it.notesList.length > 0) {
      it.notes = it.notesList.map((n: any) => {
        const text = n.content || n.contentMd || n.note || '';
        return {
          ...n,
          content: text,
          contentMd: n.contentMd || text,
          note: n.note || `<p>${text}</p>`,
          itemType: 'note',
        };
      });
    } else if (Array.isArray(it.notes) && it.notes.length > 0) {
      it.notes = it.notes.map((n: any) => {
        const text = n.content || n.contentMd || n.note || '';
        return {
          ...n,
          content: text,
          contentMd: n.contentMd || text,
          note: n.note || `<p>${text}</p>`,
          itemType: 'note',
        };
      });
    } else if (it.extraFields && typeof it.extraFields.comment === 'string') {
      const commentVal = cleanCommentText(it.extraFields.comment);
      if (commentVal) {
        const formatted = commentVal.toLowerCase().startsWith('comment:')
          ? commentVal
          : `Comment: ${commentVal}`;
        it.notes = [
          {
            id: `comment-${it.id}`,
            content: formatted,
            contentMd: formatted,
            note: `<p>${formatted}</p>`,
            itemType: 'note',
            source: 'arXiv',
            createdAt: it.createdAt || new Date().toISOString(),
            updatedAt: it.updatedAt || new Date().toISOString(),
          },
        ];
      } else {
        it.notes = [];
      }
    } else {
      it.notes = [];
    }

    if (it.extraFields && 'comment' in it.extraFields) {
      delete it.extraFields.comment;
    }

    // 9. Harmonize Publication Venue, Publisher & Field Aliases
    const baseMap = BASE_FIELD_MAPPINGS[it.itemType];
    if (baseMap) {
      const venueField = baseMap.publicationTitle;
      if (venueField && venueField !== 'publicationTitle') {
        it[venueField] = it[venueField] || it.publicationTitle || '';
        it.publicationTitle = it.publicationTitle || it[venueField] || '';
      }
      const publisherField = baseMap.publisher;
      if (publisherField && publisherField !== 'publisher') {
        it[publisherField] = it[publisherField] || it.publisher || '';
        it.publisher = it.publisher || it[publisherField] || '';
      }
      const placeField = baseMap.place;
      if (placeField && placeField !== 'place') {
        it[placeField] = it[placeField] || it.place || '';
        it.place = it.place || it[placeField] || '';
      }
      const typeField = baseMap.type;
      if (
        typeField &&
        typeField !== 'type' &&
        it.type &&
        it.type.toLowerCase() !== it.itemType.toLowerCase()
      ) {
        it[typeField] = it[typeField] || it.type;
      }
      const numberField = baseMap.number;
      if (numberField && numberField !== 'number' && it.number) {
        it[numberField] = it[numberField] || it.number;
      }
    }

    if (it.itemType === 'journalArticle' || !it.itemType) {
      it.journal = it.journal || it.publicationTitle || '';
      it.publicationTitle = it.publicationTitle || it.journal || '';
    }

    if (it.itemType === 'preprint') {
      const isArxiv = Boolean(
        it.arxivId ||
        it.archiveId ||
        it.archiveID ||
        (it.doi && String(it.doi).includes('arXiv')) ||
        (it.publicationTitle && /arxiv/i.test(it.publicationTitle)),
      );
      it.repository = it.repository || (isArxiv ? 'arXiv' : '') || '';
      it.genre = it.genre || it.type || 'Preprint';
      const cleanArxivNum = it.arxivId
        ? String(it.arxivId)
            .replace(/^arxiv:\s*/i, '')
            .replace(/v\d+$/i, '')
            .trim()
        : '';
      it.archiveID =
        it.archiveID || (cleanArxivNum ? `arXiv:${cleanArxivNum}` : '') || '';
      it.archiveId = it.archiveID;

      it.repository =
        it.repository ||
        (it.publisher && !/^arxiv$/i.test(it.publisher.trim())
          ? it.publisher
          : '') ||
        (isArxiv ? 'arXiv' : '') ||
        '';
      delete it.publisher;
      delete it.publicationTitle;
      delete it.journal;
    } else if (it.itemType === 'conferencePaper') {
      it.proceedingsTitle = it.proceedingsTitle || it.publicationTitle || '';
      it.publicationTitle = it.publicationTitle || it.proceedingsTitle || '';
      it.eventPlace = it.eventPlace || it.place || '';
      it.place = it.place || it.eventPlace || '';
    } else if (it.itemType === 'bookSection') {
      it.bookTitle = it.bookTitle || it.publicationTitle || '';
      it.publicationTitle = it.publicationTitle || it.bookTitle || '';
    } else if (it.itemType === 'thesis') {
      it.university = it.university || it.publisher || '';
      it.publisher = it.publisher || it.university || '';
      it.thesisType = it.thesisType || it.type || it.genre || '';
    } else if (it.itemType === 'report') {
      it.institution = it.institution || it.publisher || '';
      it.publisher = it.publisher || it.institution || '';
      it.reportType = it.reportType || it.type || '';
      it.reportNumber = it.reportNumber || it.number || '';
    } else if (it.itemType === 'webpage') {
      it.websiteTitle = it.websiteTitle || it.publicationTitle || '';
      it.publicationTitle = it.publicationTitle || it.websiteTitle || '';
      it.websiteType = it.websiteType || it.type || '';
    } else if (it.itemType === 'blogPost') {
      it.blogTitle = it.blogTitle || it.publicationTitle || '';
      it.publicationTitle = it.publicationTitle || it.blogTitle || '';
    } else if (it.itemType === 'patent') {
      it.issuingAuthority =
        it.issuingAuthority || it.country || it.authority || '';
      it.authority = it.authority || it.issuingAuthority || '';
      it.country = it.country || it.issuingAuthority || '';
      it.patentNumber = it.patentNumber || it.number || '';
      it.issueDate = it.issueDate || it.date || it.publicationDate || '';
      it.priorityDate = it.priorityDate || it.originalDate || '';
      it.assignee = it.assignee || it.assignee || '';
    }

    if (
      it.year === undefined ||
      it.year === null ||
      isNaN(Number(it.year)) ||
      Number(it.year) === 0
    ) {
      const dateCandidate = it.date || it.publicationDate || it.issueDate;
      if (dateCandidate) {
        const yearMatch = String(dateCandidate).match(
          /(?:^|[^\d])(1[7-9]\d{2}|20\d{2})(?:[^\d]|$)/,
        );
        if (yearMatch) {
          it.year = parseInt(yearMatch[1], 10);
        }
      }
    } else if (typeof it.year === 'string') {
      const parsedNum = parseInt(it.year, 10);
      it.year = isNaN(parsedNum) ? null : parsedNum;
    }
    it.publicationDate =
      it.publicationDate || it.date || (it.year ? String(it.year) : '');
    it.date = it.date || it.publicationDate || (it.year ? String(it.year) : '');
    it.abstract = it.abstract || it.abstractNote || '';
    it.abstractNote = it.abstract;
    it.journalAbbreviation = it.journalAbbreviation || it.journalAbbr || '';
    it.journalAbbr = it.journalAbbr || it.journalAbbreviation || '';
    it.accessDate =
      it.accessDate ||
      (it.accessedAt
        ? it.accessedAt instanceof Date
          ? it.accessedAt.toISOString()
          : String(it.accessedAt)
        : '');
    it.citationKey = it.citationKey || it.citeKey || '';
    it.citeKey = it.citeKey || it.citationKey || '';
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

    // 10. Identifier Projections
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
      it.doi = String(it.extraFields.doi || it.extraFields?.DOI);
    }
    if (!it.isbn && (it.extraFields?.isbn || it.extraFields?.ISBN)) {
      it.isbn = String(it.extraFields.isbn || it.extraFields?.ISBN);
    }
    if (!it.issn && (it.extraFields?.issn || it.extraFields?.ISSN)) {
      it.issn = String(it.extraFields.issn || it.extraFields?.ISSN);
    }
    if (!it.pmid && (it.extraFields?.pmid || it.extraFields?.PMID)) {
      it.pmid = String(it.extraFields.pmid || it.extraFields?.PMID);
    }
    if (!it.pmcid && (it.extraFields?.pmcid || it.extraFields?.PMCID)) {
      it.pmcid = String(it.extraFields.pmcid || it.extraFields?.PMCID);
    }

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

    // 12. Construct primaryFile object
    if (primaryPdfAttachment?.fileId) {
      it.primaryFile = {
        fileId: primaryPdfAttachment.fileId,
        filename: it.filename || primaryPdfAttachment.filename || '',
        title:
          primaryPdfAttachment.title ||
          primaryPdfAttachment.metadata?.title ||
          it.filename ||
          primaryPdfAttachment.filename ||
          '',
        url: it.fileUrl || '',
        size: it.size || primaryPdfAttachment.size || 0,
        mimeType:
          it.mimeType || primaryPdfAttachment.mimeType || 'application/pdf',
      };
    } else if (it.fileUrl) {
      it.primaryFile = {
        fileId: null,
        filename: it.filename || '',
        title: it.filename || '',
        url: it.fileUrl,
        size: it.size || 0,
        mimeType: it.mimeType || 'application/pdf',
      };
    } else {
      it.primaryFile = it.primaryFile ?? null;
    }

    // 13. My Publications Dual-State Harmonization
    if (it.isMyPublication === undefined) {
      if (Array.isArray(it.publications) && it.publications.length > 0) {
        it.isMyPublication = true;
      } else {
        it.isMyPublication = Boolean(it.metadata?.isMyPublication);
      }
    } else {
      it.isMyPublication = Boolean(it.isMyPublication);
    }

    // 14. Item Relations Canonical Projection
    const combinedRelations: any[] = [];
    if (Array.isArray(it.outgoingRel)) {
      for (const rel of it.outgoingRel) {
        combinedRelations.push({
          id: rel.id,
          targetItemId: rel.targetItemId,
          relationType: rel.relationType || 'related',
          direction: 'outgoing',
          description: rel.description || '',
          linkedAt: rel.createdAt,
          targetItem: rel.targetItem
            ? ItemsMapper.toDomain(rel.targetItem)
            : undefined,
        });
      }
    }
    if (Array.isArray(it.incomingRel)) {
      for (const rel of it.incomingRel) {
        combinedRelations.push({
          id: rel.id,
          targetItemId: rel.sourceItemId,
          relationType: rel.relationType || 'related',
          direction: 'incoming',
          description: rel.description || '',
          linkedAt: rel.createdAt,
          targetItem: rel.sourceItem
            ? ItemsMapper.toDomain(rel.sourceItem)
            : undefined,
        });
      }
    }
    if (combinedRelations.length === 0 && it.metadata?.relations) {
      const metaRels = it.metadata.relations;
      if (Array.isArray(metaRels)) {
        combinedRelations.push(...metaRels);
      } else if (typeof metaRels === 'object') {
        const dcRelations = metaRels['dc:relation'];
        if (Array.isArray(dcRelations)) {
          for (const uri of dcRelations) {
            combinedRelations.push({
              uri,
              relationType: 'related',
              direction: 'outgoing',
            });
          }
        } else if (typeof dcRelations === 'string' && dcRelations) {
          combinedRelations.push({
            uri: dcRelations,
            relationType: 'related',
            direction: 'outgoing',
          });
        }

        const owlSameAs = metaRels['owl:sameAs'];
        if (Array.isArray(owlSameAs)) {
          for (const uri of owlSameAs) {
            combinedRelations.push({
              uri,
              relationType: 'is_published_version_of',
              direction: 'outgoing',
              sameAs: true,
            });
          }
        } else if (typeof owlSameAs === 'string' && owlSameAs) {
          combinedRelations.push({
            uri: owlSameAs,
            relationType: 'is_published_version_of',
            direction: 'outgoing',
            sameAs: true,
          });
        }
      }
    }
    it.relations = combinedRelations;

    if (!it.seeAlso && it.metadata?.seeAlso) {
      it.seeAlso = it.metadata.seeAlso;
    } else if (!it.seeAlso && combinedRelations.length > 0) {
      it.seeAlso = combinedRelations
        .map((r) => r.targetItemId || r.uri)
        .filter(Boolean);
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
    const statesArr =
      Array.isArray(normalized.userStates) && normalized.userStates.length > 0
        ? normalized.userStates
        : Array.isArray(normalized.states) && normalized.states.length > 0
          ? normalized.states
          : null;

    if (statesArr) {
      userState = userId
        ? statesArr.find((stateRecord: any) => stateRecord.userId === userId) ||
          statesArr[0]
        : statesArr[0];
    }

    const { userStates: _userStates, states: _states, ...rest } = normalized;
    return {
      ...rest,
      isStarred:
        userState?.isStarred !== undefined
          ? Boolean(userState.isStarred)
          : Boolean(normalized.isStarred),
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

export const ItemsMapper = ItemMapper;
export type ItemsMapper = ItemMapper;
