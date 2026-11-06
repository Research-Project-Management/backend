import { CreatorCreditInput } from '@/modules/library/core/types/bibliographic.types';
import { resolveCanonicalCreatorRole, getPrimaryCreatorRoleForType } from './field-harmonizer.domain';
import { cleanAuthorName, isNoiseAuthorName, isInstitutionName, splitAuthorString, parseCreatorString } from './author.domain';
import { SCHEMA_V42_DATA } from '@/modules/library/core/types/schema.constants';
import { ITEM_TYPE_ALIASES, CSL_TYPE_TO_ITEM_TYPE } from '@/modules/library/core/domain/text.lexicon';

function extractCreatorString(input: unknown): string {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'object' && input !== null) {
    const obj = input as {
      fullName?: unknown;
      name?: unknown;
      firstName?: unknown;
      lastName?: unknown;
    };
    if (typeof obj.fullName === 'string' && obj.fullName.trim()) {
      return obj.fullName.trim();
    }
    if (typeof obj.name === 'string' && obj.name.trim()) {
      return obj.name.trim();
    }
    const parts = [obj.firstName, obj.lastName].filter(
      (p): p is string => typeof p === 'string' && Boolean(p.trim()),
    );
    return parts.join(' ');
  }
  return typeof input === 'number' || typeof input === 'boolean'
    ? String(input)
    : '';
}

/**
 * Canonical creator merging and normalization across all library entry points.
 * Preserves explicit `creatorType` via `resolveCanonicalCreatorRole`, splits full names
 * when `firstName` or `lastName` is missing (`fieldMode = 0` vs `1`), and deduplicates
 * creators by `${creatorType}:${lastName}:${firstName}`.
 */
export function mergeCanonicalCreators(
  input: {
    creators?: unknown[];
    contributors?: unknown[];
    authors?: unknown[];
    editors?: unknown[];
    itemType?: string;
  },
  primaryRole: string = 'author',
): CreatorCreditInput[] | undefined {
  const initialCreators = (
    Array.isArray(input.contributors) && input.contributors.length > 0
      ? input.contributors
      : Array.isArray(input.creators)
        ? input.creators
        : []
  ) as CreatorCreditInput[];

  const creators: CreatorCreditInput[] = [];
  const knownCreators = new Set<string>();

  const append = (
    name: string,
    creatorType: string = primaryRole,
    firstName?: string,
    lastName?: string,
    fieldMode?: number,
    shortName?: string,
    orderIndex?: number,
  ) => {
    const cleanName = (name || '').trim();
    let finalFirst = firstName?.trim() || '';
    let finalLast = lastName?.trim() || '';
    let finalFull = cleanName;
    let finalFieldMode = fieldMode;

    if (finalFieldMode === 1) {
      const rawSingle = finalLast || finalFull || finalFirst;
      const single =
        cleanAuthorName(rawSingle) ||
        (isInstitutionName(rawSingle) ? rawSingle.trim() : '');
      if (!single || (isNoiseAuthorName(single) && !isInstitutionName(single)))
        return;
      finalFirst = '';
      finalLast = single;
      finalFull = single;
    } else if (cleanName.includes(',') || !finalFirst || !finalLast) {
      const rawToParse = cleanName || `${finalFirst} ${finalLast}`.trim();
      const cleanedToParse = cleanAuthorName(rawToParse);
      if (!cleanedToParse || isNoiseAuthorName(cleanedToParse)) return;
      const parsed = parseCreatorString(
        cleanedToParse,
        orderIndex ?? creators.length,
        creatorType,
      );
      if (parsed.fieldMode === 1) {
        finalFieldMode = 1;
        finalFirst = '';
        finalLast = parsed.lastName || parsed.fullName;
        finalFull = parsed.fullName;
      } else {
        if (!finalFirst || !finalLast) {
          finalFirst = finalFirst || parsed.firstName;
          finalLast = finalLast || parsed.lastName;
        }
        finalFull = parsed.fullName || `${finalFirst} ${finalLast}`.trim();
      }
    } else if (!finalFull) {
      finalFull = `${finalFirst} ${finalLast}`.trim();
    }

    if (!finalFull && !finalFirst && !finalLast) return;
    const candidateFull = finalFull || `${finalFirst} ${finalLast}`.trim();
    if (
      isNoiseAuthorName(candidateFull) &&
      !(finalFieldMode === 1 && isInstitutionName(candidateFull))
    ) {
      return;
    }

    const dedupKey =
      finalLast || finalFirst
        ? `${creatorType}:${finalLast.toLowerCase()}:${finalFirst.toLowerCase()}`
        : `${creatorType}:${finalFull.toLowerCase()}`;
    if (knownCreators.has(dedupKey)) return;
    knownCreators.add(dedupKey);

    const displayFull = finalFull || `${finalFirst} ${finalLast}`.trim();
    creators.push({
      name: displayFull,
      fullName: displayFull,
      creatorType,
      firstName: finalFieldMode === 1 ? '' : finalFirst || '',
      lastName: finalLast || '',
      ...(finalFieldMode !== undefined ? { fieldMode: finalFieldMode } : {}),
      ...(shortName ? { shortName } : {}),
      orderIndex: orderIndex !== undefined ? orderIndex : creators.length,
    });
  };

  for (const rawC of initialCreators) {
    if (!rawC) continue;
    if (typeof rawC === 'string') {
      const role = resolveCanonicalCreatorRole(primaryRole, {
        itemType: input.itemType,
      });
      for (const splitPart of splitAuthorString(rawC)) {
        append(splitPart, role);
      }
      continue;
    }
    const c = rawC as CreatorCreditInput & Record<string, unknown>;
    const creatorType = resolveCanonicalCreatorRole(
      c.creatorType || (c.role as string | undefined) || primaryRole,
      { itemType: input.itemType },
    );
    const cFieldMode =
      typeof c.fieldMode === 'number' ? c.fieldMode : undefined;
    const cShortName =
      typeof c.shortName === 'string' && c.shortName.trim()
        ? c.shortName.trim()
        : undefined;
    const cOrderIndex =
      typeof c.orderIndex === 'number' ? c.orderIndex : undefined;

    if (cFieldMode === 1) {
      const singleName =
        c.lastName || c.fullName || c.name || c.firstName || '';
      append(
        singleName,
        creatorType,
        '',
        singleName,
        1,
        cShortName,
        cOrderIndex,
      );
      continue;
    }

    const rawName = extractCreatorString(c);
    if (rawName) {
      const hasExplicitFields =
        Boolean(c.firstName) ||
        Boolean(c.lastName) ||
        cFieldMode === 1 ||
        Boolean(c.fullName) ||
        Boolean(c.name);
      const shouldSplitObjName =
        !hasExplicitFields ||
        rawName.includes(';') ||
        (rawName.includes(',') &&
          !/,\s*(?:Jr\.?|Sr\.?|II|III|IV|V|Esq\.?)$/i.test(rawName));
      const parts = shouldSplitObjName ? splitAuthorString(rawName) : [rawName];
      for (const p of parts) {
        const useSingleField =
          cFieldMode === 1 ||
          (!c.firstName &&
            !c.lastName &&
            (isInstitutionName(p) || /\s+(?:and|&)\s+/i.test(p)));
        append(
          p,
          creatorType,
          c.firstName || undefined,
          c.lastName || (useSingleField ? p : undefined),
          useSingleField ? 1 : cFieldMode,
          cShortName,
          cOrderIndex,
        );
      }
    } else if (c.firstName || c.lastName) {
      append(
        '',
        creatorType,
        c.firstName || undefined,
        c.lastName || undefined,
        cFieldMode,
        cShortName,
        cOrderIndex,
      );
    }
  }

  const appendStringRoleList = (
    list: unknown[] | undefined,
    role: string,
    checkAnyInitialRole: boolean,
  ) => {
    const resolvedRole = resolveCanonicalCreatorRole(role, {
      itemType: input.itemType,
    });
    for (const rawEntry of list || []) {
      const rawStr = extractCreatorString(rawEntry).trim();
      if (!rawStr) continue;
      const lowerStr = rawStr.toLowerCase();
      if (
        checkAnyInitialRole &&
        initialCreators.some(
          (ic) => extractCreatorString(ic).trim().toLowerCase() === lowerStr,
        )
      ) {
        continue;
      }
      if (
        knownCreators.has(`${resolvedRole}:${lowerStr}:`) ||
        knownCreators.has(`${resolvedRole}:${lowerStr}`)
      ) {
        continue;
      }
      for (const splitPart of splitAuthorString(rawStr)) {
        append(splitPart, resolvedRole);
      }
    }
  };

  appendStringRoleList(input.authors, primaryRole, true);
  appendStringRoleList(input.editors, 'editor', false);

  return creators.length > 0 ? creators : undefined;
}

export function deriveFirstAuthor(data: {
  contributors?: Array<Record<string, unknown> | CreatorCreditInput>;
  creators?: Array<Record<string, unknown> | CreatorCreditInput>;
  authors?: Array<string | Record<string, unknown>>;
  author?: string;
  editors?: Array<string | Record<string, unknown>>;
  itemType?: string;
}): string | null {
  const formatResult = (name: string, count: number): string | null => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    return (count > 1 ? `${trimmed} et al.` : trimmed).slice(0, 255);
  };

  const primaryRoleLower = getPrimaryCreatorRoleForType(data.itemType).toLowerCase();
  const structured =
    data.contributors && data.contributors.length > 0
      ? data.contributors
      : data.creators && data.creators.length > 0
        ? data.creators
        : null;
  if (structured) {
    const isAuthorRole = (c: Record<string, unknown>) => {
      const role = String(c.creatorType || c.role || 'author').trim().toLowerCase();
      return role === 'author' || role === primaryRoleLower || role === 'creator' || role === '';
    };
    const isNonEditorRole = (c: Record<string, unknown>) => {
      const role = String(c.creatorType || c.role || 'author').trim().toLowerCase();
      return role !== 'editor' && role !== 'serieseditor';
    };

    const preferredPool = structured.filter((c) => isAuthorRole(c as Record<string, unknown>));
    const nonEditorPool = preferredPool.length > 0 ? preferredPool : structured.filter((c) => isNonEditorRole(c as Record<string, unknown>));
    const effectivePool = nonEditorPool.length > 0 ? nonEditorPool : structured;

    const c0 = effectivePool[0] as Record<string, unknown>;
    const rawLast = (c0.lastName as string) || '';
    const rawFull = (c0.fullName as string) || (c0.name as string) || '';
    let authorName = rawLast;
    if (!authorName && rawFull) {
      const parsed = parseCreatorString(rawFull, 0);
      authorName = parsed.lastName || parsed.fullName || rawFull;
    }
    if (!authorName) return null;
    return formatResult(authorName, effectivePool.length);
  }
  const authorList =
    data.authors && data.authors.length > 0
      ? data.authors
      : typeof data.author === 'string' && data.author.trim()
        ? [data.author.trim()]
        : data.editors && data.editors.length > 0
          ? data.editors
          : null;
  if (authorList && authorList.length > 0) {
    const firstAuthor = authorList[0] as string | { name?: string; fullName?: string; lastName?: string } | undefined;
    const authorStr: string =
      typeof firstAuthor === 'string' ? firstAuthor : firstAuthor?.name || firstAuthor?.fullName || firstAuthor?.lastName || '';
    const parsed0 = parseCreatorString(authorStr, 0);
    const authorName = parsed0.lastName || parsed0.fullName;
    if (!authorName) return null;
    return formatResult(authorName, authorList.length);
  }
  return null;
}

/**
 * Maps a raw CSL type string to the canonical Zotero itemType.
 * Falls back to ITEM_TYPE_ALIASES for BibTeX/RIS variants, then 'journalArticle'.
 */
export function mapCslTypeToZoteroItemType(cslType?: string | null): string {
  if (!cslType) return 'journalArticle';
  const trimmed = cslType.trim();
  const lower = trimmed.toLowerCase();
  if (CSL_TYPE_TO_ITEM_TYPE[trimmed]) return CSL_TYPE_TO_ITEM_TYPE[trimmed];
  if (CSL_TYPE_TO_ITEM_TYPE[lower]) return CSL_TYPE_TO_ITEM_TYPE[lower];
  if (ITEM_TYPE_ALIASES[lower]) return ITEM_TYPE_ALIASES[lower];
  const cleaned = lower.replace(/[\s_-]+/g, '');
  if (ITEM_TYPE_ALIASES[cleaned]) return ITEM_TYPE_ALIASES[cleaned];
  return 'journalArticle';
}

interface PdfItemTypeSignals {
  title?: string;
  notes?: Array<string | { content?: string }>;
  journal?: string;
  conferenceName?: string;
  bookTitle?: string;
  isbn?: string;
  publisher?: string;
  filename?: string;
  /** Plain text from first N pages for deeper heuristics */
  rawText?: string;
}

interface InferredItemType {
  itemType: string;
  /** 0–1 confidence: how certain the heuristic is */
  confidence: number;
  /** Which signal triggered the decision */
  reason: string;
}

/**
 * Infers the probable itemType for a PDF that has no DOI, arXiv ID,
 * or other authoritative identifier, by applying deterministic text heuristics
 * on metadata signals extracted from PDF (title, notes, conference name, etc.).
 *
 * Returns undefined when no signal is strong enough — the caller should fall
 * back to the pipeline default (`journalArticle`).
 *
 * Heuristic tiers (highest confidence first):
 *  1. ISBN present → book or bookSection
 *  2. conferenceName / bookTitle from structural signals → conferencePaper / bookSection
 *  3. Title/notes keyword patterns for thesis, report, preprint, patent, dataset
 *  4. Filename-level patterns as a last resort
 */
export function inferItemTypeFromPdfSignals(
  signals: PdfItemTypeSignals,
): InferredItemType | undefined {
  const titleLower = (signals.title || '').toLowerCase();
  const filenameLower = (signals.filename || '').toLowerCase();

  // Collapse notes into a single searchable string
  const notesText = (signals.notes || [])
    .map((n) => (typeof n === 'string' ? n : n?.content || ''))
    .join(' ')
    .toLowerCase();

  const combined = `${titleLower} ${notesText}`;

  // Tier 1: ISBN present → book-class document
  if (signals.isbn) {
    if (signals.bookTitle) {
      return {
        itemType: 'bookSection',
        confidence: 0.88,
        reason: 'isbn+bookTitle',
      };
    }
    return { itemType: 'book', confidence: 0.85, reason: 'isbn' };
  }

  // Tier 2: Structural venue signals
  if (signals.conferenceName) {
    return {
      itemType: 'conferencePaper',
      confidence: 0.87,
      reason: 'structural:conferenceName',
    };
  }

  if (signals.bookTitle) {
    return {
      itemType: 'bookSection',
      confidence: 0.85,
      reason: 'structural:bookTitle',
    };
  }

  // Tier 3a: Thesis patterns
  const THESIS_TITLE =
    /\b(ph\.?d\.?|doctoral|master'?s?|m\.?sc?\.?|m\.?eng?\.?|bachelor'?s?|undergraduate)\s+(thesis|dissertation)\b/i;
  // Only match structural thesis phrasing — NOT bare "submitted to <journal>"
  // (preprint detection below handles that case).
  const THESIS_NOTE =
    /\b(in\s+partial\s+(fulfil(?:l?ment)?|fulfil)|for\s+the\s+degree\s+of|for\s+the\s+award\s+of|for\s+graduation|thesis\s+advisor|thesis\s+supervisor|dissertation\s+committee)\b/i;
  const THESIS_TITLE2 = /\bthesis\b|\bdissertation\b/i;

  if (THESIS_TITLE.test(titleLower) || THESIS_NOTE.test(notesText)) {
    return {
      itemType: 'thesis',
      confidence: 0.92,
      reason: 'thesis:title+note',
    };
  }
  if (THESIS_TITLE2.test(titleLower) && notesText.length > 0) {
    return { itemType: 'thesis', confidence: 0.8, reason: 'thesis:title' };
  }

  // Tier 3b: Report patterns
  const REPORT_TITLE =
    /\b(technical\s+report|research\s+report|white\s+paper|whitepaper|working\s+paper|discussion\s+paper|policy\s+brief|deliverable\s+d?\d|internal\s+report|annual\s+report|progress\s+report)\b/i;
  const REPORT_NOTE =
    /\b(report\s+no\.?|report\s+number|tech\.?\s+report|nist|nasa\s+tm|nasa\s+cr|afrl|dtic|rand\s+corporation)\b/i;

  if (REPORT_TITLE.test(titleLower) || REPORT_TITLE.test(notesText)) {
    return { itemType: 'report', confidence: 0.88, reason: 'report:title' };
  }
  if (REPORT_NOTE.test(notesText)) {
    return { itemType: 'report', confidence: 0.78, reason: 'report:note' };
  }

  // Tier 3c: Preprint — checked BEFORE conference venue names
  // "submitted to <venue>" or "under review at <conference>" → preprint.
  // Must fire before CONF_TITLE so venue names in notes (ICML, JMLR) do not
  // incorrectly trigger conferencePaper.
  const PREPRINT_NOTE =
    /\b(preprint|under\s+review|submitted\s+to\b|to\s+appear\s+in|not\s+peer[\s-]reviewed|biorxiv|medrxiv|ssrn|chemrxiv)\b/i;
  // Use delimiter-aware pattern (no \b) so underscored filenames like
  // "arxiv_2310.06825v2.pdf" are matched correctly.
  const PREPRINT_FILENAME =
    /(?:^|[\s_\-./])(arxiv|preprint|biorxiv|medrxiv|ssrn)(?:$|[\s_\-./\d])/i;

  if (PREPRINT_NOTE.test(combined)) {
    return { itemType: 'preprint', confidence: 0.82, reason: 'preprint:note' };
  }
  if (PREPRINT_FILENAME.test(filenameLower)) {
    return {
      itemType: 'preprint',
      confidence: 0.75,
      reason: 'preprint:filename',
    };
  }

  // Tier 3d: Conference paper patterns (title/notes only)
  const CONF_TITLE =
    /\b(proceedings\s+of|in\s+proceedings|proc\.\s+of|workshop\s+on|symposium\s+on|conference\s+on|annual\s+conference|international\s+conference|ieee\s+[a-z]+\s+\d{4}|acm\s+[a-z]+\s+\d{4}|neurips|icml|iclr|cvpr|eccv|iccv|emnlp|acl\s+\d{4}|naacl|aaai\s+\d{4}|ijcai|sigchi|chi\s+\d{4})\b/i;

  if (CONF_TITLE.test(titleLower) || CONF_TITLE.test(notesText)) {
    return {
      itemType: 'conferencePaper',
      confidence: 0.83,
      reason: 'conference:pattern',
    };
  }

  const PATENT_TITLE =
    /\b(patent|us\s*\d{7,}|ep\s*\d{7,}|wo\s*\d{4}\/\d{6}|patent\s+application|utility\s+patent|international\s+publication)\b/i;

  if (PATENT_TITLE.test(titleLower) || PATENT_TITLE.test(notesText)) {
    return { itemType: 'patent', confidence: 0.85, reason: 'patent:pattern' };
  }

  // Tier 3f: Dataset patterns
  const DATASET_TITLE =
    /\b(dataset|data\s+set|benchmark\s+dataset|corpus|annotated\s+(corpus|dataset)|knowledge\s+base|data\s+paper)\b/i;

  if (DATASET_TITLE.test(titleLower)) {
    return { itemType: 'dataset', confidence: 0.78, reason: 'dataset:title' };
  }

  // Tier 3g: Presentation patterns
  const PRES_TITLE =
    /\b(tutorial|keynote(\s+talk)?|invited\s+talk|slide|presentation)\b/i;

  if (PRES_TITLE.test(titleLower)) {
    return {
      itemType: 'presentation',
      confidence: 0.72,
      reason: 'presentation:title',
    };
  }

  // Tier 4: Filename last-resort
  // Use delimiter-aware patterns (not \b) so underscored filenames like
  // "john_doe_phd_thesis_2023.pdf" are caught correctly.
  if (
    /(?:^|[\s_\-.])(thesis|dissertation)(?:$|[\s_\-.\d])/i.test(filenameLower)
  ) {
    return { itemType: 'thesis', confidence: 0.65, reason: 'thesis:filename' };
  }
  if (
    /(?:^|[\s_\-.])(report|techreport|whitepaper)(?:$|[\s_\-.\d])/i.test(
      filenameLower,
    )
  ) {
    return { itemType: 'report', confidence: 0.6, reason: 'report:filename' };
  }
  if (
    /(?:^|[\s_\-.])(proceedings|conference|workshop|symposium)(?:$|[\s_\-.\d])/i.test(
      filenameLower,
    )
  ) {
    return {
      itemType: 'conferencePaper',
      confidence: 0.6,
      reason: 'conference:filename',
    };
  }

  return undefined;
}

export function normalizeCanonicalItemType(
  rawType: string | undefined | null,
  canonicalTypes?: Record<string, unknown>,
): string {
  if (!rawType || typeof rawType !== 'string') {
    return 'journalArticle';
  }

  const trimmed = rawType.trim();
  const lower = trimmed.toLowerCase();

  if (canonicalTypes) {
    const matchedKey = Object.keys(canonicalTypes).find(
      (k) => k.toLowerCase() === lower,
    );
    if (matchedKey) return matchedKey;
  }

  if (ITEM_TYPE_ALIASES[lower]) {
    return ITEM_TYPE_ALIASES[lower];
  }

  const cleaned = lower.replace(/[\s_-]+/g, '');
  if (ITEM_TYPE_ALIASES[cleaned]) {
    return ITEM_TYPE_ALIASES[cleaned];
  }

  return 'journalArticle';
}

export function normalizeItemType(type?: string | null): string {
  return normalizeCanonicalItemType(type, SCHEMA_V42_DATA.itemTypes);
}
