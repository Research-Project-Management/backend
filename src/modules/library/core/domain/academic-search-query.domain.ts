import {
  normalizeDoi,
  normalizeIsbn,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIssn,
} from './identifier.domain';

export interface NormalizedSearchIdentifiers {
  cleanDoi?: string;
  cleanIsbn?: string;
  cleanArxiv?: string;
  cleanArxivBase?: string;
  cleanPmid?: string;
  cleanPmcid?: string;
  cleanIssn?: string;
}

/**
 * AcademicSearchQueryEngine — Deep Module encapsulating:
 * 1. Canonical academic identifier extraction from arbitrary search strings (DOI, ISBN, arXiv, PMID, PMCID, ISSN).
 * 2. ReDoS-safe regular expression validation and `/pattern/flags` parsing for full-text PDF search.
 * 3. Unified Prisma JSONB / column identifier search clause construction across Search & Catalog.
 * 4. In-memory identifier matching for Smart Folder (`SavedSearch`) condition evaluation.
 */
export class AcademicSearchQueryEngine {
  /**
   * Extracts normalized academic identifiers from a raw search query string if present.
   */
  static extractIdentifiers(rawQuery?: string): NormalizedSearchIdentifiers {
    const q = (rawQuery ?? '').trim();
    if (!q) return {};
    const cleanDoi = normalizeDoi(q);
    let cleanIsbn = normalizeIsbn(q);
    if (!cleanIsbn) {
      const isbnMatch = q.match(
        /(?:isbn(?:-1[03])?:?\s*)?((?:97[89][-\s]?(?:\d[-\s]?){9}\d)|(?:\d[-\s]?){9}[\dXx])\b/i,
      );
      if (isbnMatch?.[1]) {
        cleanIsbn = normalizeIsbn(isbnMatch[1]);
      }
    }
    let cleanArxiv = normalizeArxivId(q);
    let cleanArxivBase = normalizeArxivId(q, { stripVersion: true });
    if (!cleanArxiv) {
      const arxivMatch = q.match(
        /(?:arxiv:\s*|arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5}(?:v\d+)?)\b/i,
      );
      if (arxivMatch?.[1]) {
        cleanArxiv = normalizeArxivId(arxivMatch[1]);
        cleanArxivBase = normalizeArxivId(arxivMatch[1], {
          stripVersion: true,
        });
      }
    }
    const pmidMatch = q.match(/(?:^(\d{6,9})$|\bpmid:\s*(\d{6,9})\b)/i);
    const extractedPmidRaw = pmidMatch?.[1] || pmidMatch?.[2];
    const cleanPmid =
      /^pmid\s*:/i.test(q) || /^\d{6,9}$/.test(q)
        ? normalizePmid(q)
        : extractedPmidRaw
          ? normalizePmid(extractedPmidRaw)
          : undefined;
    const pmcidMatch = q.match(/\b(pmc\d{1,9})\b/i);
    const cleanPmcid = /^pmc/i.test(q)
      ? normalizePmcid(q)
      : pmcidMatch?.[1]
        ? normalizePmcid(pmcidMatch[1])
        : undefined;
    let cleanIssn = normalizeIssn(q);
    if (!cleanIssn) {
      const issnMatch = q.match(/\b(\d{4}-\d{3}[\dXx])\b/);
      if (issnMatch?.[1]) {
        cleanIssn = normalizeIssn(issnMatch[1]);
      }
    }
    return {
      cleanDoi,
      cleanIsbn,
      cleanArxiv,
      cleanArxivBase,
      cleanPmid,
      cleanPmcid,
      cleanIssn,
    };
  }

  /**
   * Normalizes a targeted identifier field value (e.g. in SavedSearch / Smart Folder rules)
   * so that URL-wrapped or hyphenated inputs match canonical stored values.
   */
  static normalizeFieldTargetValue(field: string, rawValue: string): string {
    const trimmed = (rawValue ?? '').trim();
    if (!trimmed) return '';
    switch (field) {
      case 'doi':
        return normalizeDoi(trimmed) || trimmed;
      case 'isbn':
        return normalizeIsbn(trimmed) || trimmed;
      case 'arxivId':
        return normalizeArxivId(trimmed) || trimmed;
      case 'pmid':
        return normalizePmid(trimmed) || trimmed;
      case 'pmcid':
        return normalizePmcid(trimmed) || trimmed;
      case 'issn':
        return normalizeIssn(trimmed) || trimmed;
      default:
        return trimmed;
    }
  }

  /**
   * Guards against catastrophic backtracking (ReDoS) in user-supplied regex patterns.
   * Uses a parenthesis-depth stack to reject any quantified group that contains an
   * inner repeating quantifier or overlapping alternation, regardless of group nesting depth.
   */
  static isSafeRegex(pattern: string): boolean {
    if (!pattern || pattern.length > 200) return false;
    // Reject backreferences which are non-regular and can cause exponential evaluation
    if (/\\[1-9]/.test(pattern)) return false;
    // Reject overlapping alternation inside a quantified group, e.g. (a|aa)+ or (aa|a)+
    if (/\(([^()|]+)\|\1[^()]*\)[+*?{]/.test(pattern)) return false;

    const groupStack: Array<{
      hasQuantifierInside: boolean;
      startIndex: number;
    }> = [];
    let inCharClass = false;

    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === '\\') {
        i++; // skip escaped character
        continue;
      }
      if (inCharClass) {
        if (ch === ']') inCharClass = false;
        continue;
      }
      if (ch === '[') {
        inCharClass = true;
        continue;
      }
      if (ch === '(') {
        groupStack.push({ hasQuantifierInside: false, startIndex: i });
        continue;
      }
      if (ch === '+' || ch === '*' || ch === '{') {
        for (const openGroup of groupStack) {
          openGroup.hasQuantifierInside = true;
        }
        continue;
      }
      if (ch === '?') {
        const isGroupModifier =
          groupStack.length > 0 &&
          groupStack[groupStack.length - 1].startIndex === i - 1;
        if (!isGroupModifier) {
          for (const openGroup of groupStack) {
            openGroup.hasQuantifierInside = true;
          }
        }
        continue;
      }
      if (ch === ')') {
        const closedGroup = groupStack.pop();
        const nextCh = pattern[i + 1];
        const isGroupQuantified =
          nextCh === '+' || nextCh === '*' || nextCh === '?' || nextCh === '{';
        if (closedGroup && isGroupQuantified) {
          if (closedGroup.hasQuantifierInside) {
            return false;
          }
          // Check if quantified group has alternation with shared prefix characters or overlapping classes
          const groupBody = pattern
            .slice(closedGroup.startIndex + 1, i)
            .replace(/^\?(?::|=|!|<=|<!|<[^>]+>)/, '');
          if (groupBody.includes('|')) {
            const branches = groupBody.split('|').map((b) => b.trim());
            const firstChars = new Set<string>();
            for (const branch of branches) {
              const lead = branch[0] || '';
              if (
                !lead ||
                lead === '.' ||
                lead === '[' ||
                lead === '\\' ||
                firstChars.has(lead)
              ) {
                return false;
              }
              firstChars.add(lead);
            }
          }
        }
      }
    }

    return true;
  }

  /**
   * Parses `/pattern/flags` syntax into a RegExp if safe, otherwise returns null.
   */
  static parseSafeRegex(rawTerm: string): RegExp | null {
    const trimmed = (rawTerm ?? '').trim();
    const slashMatch = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
    if (!slashMatch) return null;
    const [, body, rawFlags] = slashMatch;
    if (!this.isSafeRegex(body)) return null;
    try {
      const cleanFlags = Array.from(
        new Set((rawFlags.replace(/[^gimsu]/g, '') + 'gi').split('')),
      ).join('');
      return new RegExp(body, cleanFlags);
    } catch {
      return null;
    }
  }

  /**
   * Sanitizes search input to prevent SQL injection or tsquery syntax breaking.
   */
  static sanitizeTsQuery(query?: string): string {
    if (!query) return '';
    return query
      .replace(/['":*&|!()\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Builds Prisma `OR` metadata JSONB + relational `ItemIdentifier` clauses for normalized identifiers.
   */
  static buildMetadataIdentifierOrClauses(
    ids: NormalizedSearchIdentifiers,
  ): Array<Record<string, unknown>> {
    const clauses: Array<Record<string, unknown>> = [];
    if (ids.cleanDoi) {
      clauses.push({
        identifiers: {
          some: {
            type: 'doi',
            value: { contains: ids.cleanDoi, mode: 'insensitive' },
          },
        },
      });
    }
    if (ids.cleanIsbn) {
      clauses.push(
        { metadata: { path: ['isbn'], string_contains: ids.cleanIsbn } },
        {
          identifiers: {
            some: {
              type: 'isbn',
              value: { contains: ids.cleanIsbn, mode: 'insensitive' },
            },
          },
        },
      );
    }
    if (ids.cleanArxivBase || ids.cleanArxiv) {
      const arxivVal = ids.cleanArxivBase || ids.cleanArxiv!;
      clauses.push(
        { metadata: { path: ['arxivId'], string_contains: arxivVal } },
        {
          identifiers: {
            some: {
              type: 'arxiv',
              value: { contains: arxivVal, mode: 'insensitive' },
            },
          },
        },
      );
    }
    if (ids.cleanPmid) {
      clauses.push(
        { metadata: { path: ['pmid'], string_contains: ids.cleanPmid } },
        {
          identifiers: {
            some: {
              type: 'pmid',
              value: { contains: ids.cleanPmid, mode: 'insensitive' },
            },
          },
        },
      );
    }
    if (ids.cleanPmcid) {
      clauses.push(
        { metadata: { path: ['pmcid'], string_contains: ids.cleanPmcid } },
        {
          identifiers: {
            some: {
              type: 'pmcid',
              value: { contains: ids.cleanPmcid, mode: 'insensitive' },
            },
          },
        },
      );
    }
    if (ids.cleanIssn) {
      clauses.push(
        { metadata: { path: ['issn'], string_contains: ids.cleanIssn } },
        {
          identifiers: {
            some: {
              type: 'issn',
              value: { contains: ids.cleanIssn, mode: 'insensitive' },
            },
          },
        },
      );
    }
    return clauses;
  }

  /**
   * Checks whether an in-memory Item object matches any of the extracted canonical identifiers.
   */
  static matchesItemIdentifiersInMemory(
    item: Record<string, unknown>,
    ids: NormalizedSearchIdentifiers,
  ): boolean {
    if (
      ids.cleanDoi &&
      typeof item.doi === 'string' &&
      item.doi.toLowerCase().includes(ids.cleanDoi.toLowerCase())
    ) {
      return true;
    }
    if (Array.isArray(item.identifiers)) {
      for (const rawIdent of item.identifiers) {
        if (!rawIdent || typeof rawIdent !== 'object') continue;
        const ident = rawIdent as { type?: string; value?: string };
        const t = (ident.type || '').trim().toLowerCase();
        const v = (ident.value || '').trim();
        if (!v) continue;
        if (
          ids.cleanDoi &&
          t === 'doi' &&
          v.toLowerCase().includes(ids.cleanDoi.toLowerCase())
        ) {
          return true;
        }
        if (ids.cleanIsbn && t === 'isbn') {
          const normIsbn =
            normalizeIsbn(v) || v.replace(/[-\s]/g, '').toUpperCase();
          if (normIsbn.includes(ids.cleanIsbn.toUpperCase())) return true;
        }
        if (
          (ids.cleanArxivBase || ids.cleanArxiv) &&
          (t === 'arxiv' || t === 'arxivid') &&
          v
            .toLowerCase()
            .includes((ids.cleanArxivBase || ids.cleanArxiv)!.toLowerCase())
        ) {
          return true;
        }
        if (ids.cleanPmid && t === 'pmid') {
          const normPmid = normalizePmid(v) || v;
          if (normPmid === ids.cleanPmid) return true;
        }
        if (
          ids.cleanPmcid &&
          (t === 'pmcid' || t === 'pmc') &&
          v.toUpperCase().includes(ids.cleanPmcid.toUpperCase())
        ) {
          return true;
        }
        if (
          ids.cleanIssn &&
          t === 'issn' &&
          v.toUpperCase().includes(ids.cleanIssn.toUpperCase())
        ) {
          return true;
        }
      }
    }
    const meta =
      item.metadata &&
      typeof item.metadata === 'object' &&
      !Array.isArray(item.metadata)
        ? (item.metadata as Record<string, unknown>)
        : {};
    if (ids.cleanIsbn && typeof meta.isbn === 'string') {
      const normalizedStoredIsbn =
        normalizeIsbn(meta.isbn) ||
        meta.isbn.replace(/[-\s]/g, '').toUpperCase();
      if (normalizedStoredIsbn.includes(ids.cleanIsbn.toUpperCase())) {
        return true;
      }
    }
    if (
      (ids.cleanArxivBase || ids.cleanArxiv) &&
      typeof meta.arxivId === 'string' &&
      meta.arxivId
        .toLowerCase()
        .includes((ids.cleanArxivBase || ids.cleanArxiv)!.toLowerCase())
    ) {
      return true;
    }
    if (ids.cleanPmid && typeof meta.pmid === 'string') {
      const normalizedStoredPmid =
        normalizePmid(meta.pmid) || meta.pmid.trim();
      if (normalizedStoredPmid === ids.cleanPmid) {
        return true;
      }
    }
    if (
      ids.cleanPmcid &&
      typeof meta.pmcid === 'string' &&
      meta.pmcid.toUpperCase().includes(ids.cleanPmcid)
    ) {
      return true;
    }
    if (
      ids.cleanIssn &&
      typeof meta.issn === 'string' &&
      meta.issn.toUpperCase().includes(ids.cleanIssn)
    ) {
      return true;
    }
    return false;
  }
}

export function extractSearchQueryIdentifiers(
  rawQuery?: string,
): NormalizedSearchIdentifiers {
  return AcademicSearchQueryEngine.extractIdentifiers(rawQuery);
}

export function isSafeSearchRegex(pattern: string): boolean {
  return AcademicSearchQueryEngine.isSafeRegex(pattern);
}

export function parseSafeSearchRegex(rawTerm: string): RegExp | null {
  return AcademicSearchQueryEngine.parseSafeRegex(rawTerm);
}
