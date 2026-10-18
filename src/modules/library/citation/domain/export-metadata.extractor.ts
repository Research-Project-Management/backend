import { Prisma } from '@prisma/client';

export interface ExportMetadataResult {
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  isbn?: string;
  issn?: string;
  pmid?: string;
  pmcid?: string;
  arxivId?: string;
  citationKey?: string;
  edition?: string;
  place?: string;
  series?: string;
  accessedAt?: string;
  accessDate?: string;
  extra?: string;
  extraFields?: Record<string, unknown>;
}

export function extractExportMetadata(it: {
  metadata?: Prisma.JsonValue | null;
  itemTags?: Array<{ tag?: { name?: string | null } | null }> | null;
}): ExportMetadataResult {
  const meta =
    it.metadata &&
    typeof it.metadata === 'object' &&
    !Array.isArray(it.metadata)
      ? (it.metadata as Record<string, unknown>)
      : {};
  const extraStr = typeof meta.extra === 'string' ? meta.extra : undefined;
  const extraMap: Record<string, string> = {};
  if (extraStr) {
    for (const match of extraStr.matchAll(
      /\{:\s*([a-zA-Z_][a-zA-Z0-9_.\s-]*?)\s*:\s*([^}]+?)\s*\}/g,
    )) {
      const k = match[1]
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '-');
      extraMap[k] = match[2].trim();
    }
    for (const line of extraStr.split(/\r?\n/)) {
      const m = line
        .trim()
        .match(/^([a-zA-Z_][a-zA-Z0-9_.\s-]{0,40}):\s*(.+)$/);
      if (m) {
        const k = m[1]
          .trim()
          .toLowerCase()
          .replace(/[\s_]+/g, '-');
        if (!extraMap[k]) extraMap[k] = m[2].trim();
      }
    }
  }

  const tagNames = Array.isArray(it.itemTags)
    ? it.itemTags
        .map((t) => t?.tag?.name?.trim())
        .filter((n): n is string => Boolean(n))
    : [];
  const metaKeywords = Array.isArray(meta.keywords)
    ? meta.keywords.filter((k): k is string => typeof k === 'string')
    : [];
  const combinedKeywords = Array.from(new Set([...metaKeywords, ...tagNames]));

  return {
    publisher:
      (typeof meta.publisher === 'string' && meta.publisher) ||
      (typeof meta.university === 'string' && meta.university) ||
      (typeof meta.institution === 'string' && meta.institution) ||
      (typeof meta.company === 'string' && meta.company) ||
      (typeof meta.organization === 'string' && meta.organization) ||
      extraMap['publisher'] ||
      undefined,
    volume:
      (typeof meta.volume === 'string' && meta.volume) ||
      (typeof meta.reporterVolume === 'string' && meta.reporterVolume) ||
      (typeof meta.codeNumber === 'string' && meta.codeNumber) ||
      extraMap['volume'] ||
      undefined,
    issue:
      (typeof meta.issue === 'string' && meta.issue) ||
      extraMap['issue'] ||
      extraMap['number'] ||
      undefined,
    pages:
      (typeof meta.pages === 'string' && meta.pages) ||
      (typeof meta.firstPage === 'string' && meta.firstPage) ||
      extraMap['pages'] ||
      extraMap['page'] ||
      undefined,
    doi:
      (typeof meta.doi === 'string' && meta.doi) ||
      extraMap['doi']?.replace(
        /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i,
        '',
      ) ||
      undefined,
    isbn:
      (typeof meta.isbn === 'string' && meta.isbn) ||
      extraMap['isbn'] ||
      undefined,
    issn:
      (typeof meta.issn === 'string' && meta.issn) ||
      extraMap['issn'] ||
      undefined,
    pmid:
      (typeof meta.pmid === 'string' && meta.pmid) ||
      extraMap['pmid'] ||
      undefined,
    pmcid:
      (typeof meta.pmcid === 'string' && meta.pmcid) ||
      extraMap['pmcid'] ||
      undefined,
    arxivId:
      (typeof meta.arxivId === 'string' && meta.arxivId) ||
      extraMap['arxiv'] ||
      extraMap['arxivid'] ||
      undefined,
    citationKey:
      extraMap['citation-key'] ||
      extraMap['citationkey'] ||
      extraMap['bibtex'] ||
      extraMap['tex.ids']?.split(/[,\s]+/)[0] ||
      undefined,
    edition: typeof meta.edition === 'string' ? meta.edition : undefined,
    place:
      (typeof meta.place === 'string' && meta.place) ||
      (typeof meta.eventPlace === 'string' && meta.eventPlace) ||
      (typeof meta.country === 'string' && meta.country) ||
      extraMap['event-place'] ||
      extraMap['publisher-place'] ||
      extraMap['place'] ||
      undefined,
    series:
      (typeof meta.series === 'string' && meta.series) ||
      (typeof meta.seriesTitle === 'string' && meta.seriesTitle) ||
      extraMap['collection-title'] ||
      undefined,
    accessedAt:
      typeof meta.accessedAt === 'string' ? meta.accessedAt : undefined,
    accessDate:
      typeof meta.accessDate === 'string' ? meta.accessDate : undefined,
    extra: extraStr,
    extraFields: {
      ...meta,
      ...(combinedKeywords.length > 0 ? { keywords: combinedKeywords } : {}),
    },
  };
}
