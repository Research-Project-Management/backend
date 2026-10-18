import { Injectable, Logger } from '@nestjs/common';
import { mapCslTypeToZoteroItemType } from '@/modules/library/core';
import { normalizeAcademicTags } from '@/modules/library/core/domain/tag.domain';

export interface ParsedCslEntry {
  title: string;
  itemType: string;
  authors?: string[];
  editors?: string[];
  creators?: Array<{
    name: string;
    fullName?: string;
    firstName?: string;
    lastName?: string;
    creatorType: string;
    fieldMode?: number;
  }>;
  year?: number;
  publicationDate?: string;
  accessedAt?: string;
  publicationTitle?: string;
  journal?: string;
  journalAbbr?: string;
  shortTitle?: string;
  publisher?: string;
  place?: string;
  eventPlace?: string;
  conferenceName?: string;
  proceedingsTitle?: string;
  bookTitle?: string;
  university?: string;
  thesisType?: string;
  institution?: string;
  reportNumber?: string;
  reportType?: string;
  issuingAuthority?: string;
  patentNumber?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  numPages?: string;
  numberOfVolumes?: string;
  series?: string;
  seriesNumber?: string;
  edition?: string;
  section?: string;
  versionNumber?: string;
  callNumber?: string;
  archive?: string;
  archiveLocation?: string;
  libraryCatalog?: string;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  arxivId?: string;
  isbn?: string;
  issn?: string;
  url?: string;
  abstract?: string;
  citationKey?: string;
  tags?: string[];
  keywords?: string[];
  notes?: string[];
  language?: string;
  rights?: string;
  extra?: string;
  extraFields?: Record<string, unknown>;
  [key: string]: unknown;
}

@Injectable()
export class CslParser {
  private readonly logger = new Logger(CslParser.name);

  /**
   * Parse a raw CSL-JSON string or object/array into a standardized list of entries.
   */
  parse(content: unknown): ParsedCslEntry[] {
    if (!content) return [];

    const toStr = (val: unknown): string =>
      typeof val === 'string' || typeof val === 'number'
        ? String(val).trim()
        : '';
    const toOptStr = (val: unknown): string | undefined => {
      const s = toStr(val);
      return s || undefined;
    };

    let items: unknown[] = [];
    try {
      const parsed: unknown =
        typeof content === 'string' ? JSON.parse(content) : content;
      items = Array.isArray(parsed) ? parsed : [parsed];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`Failed to parse CSL JSON content: ${msg}`);
      return [];
    }

    const results: ParsedCslEntry[] = [];

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const csl = item as Record<string, unknown>;

      const itemType = mapCslTypeToZoteroItemType(csl.type as string);

      const authors = this.extractPeople(csl.author);
      const editors = this.extractPeople(csl.editor);

      const creators = [
        ...this.buildCreators(csl.author, 'author'),
        ...this.buildCreators(csl.editor, 'editor'),
        ...this.buildCreators(csl.translator, 'translator'),
        ...this.buildCreators(csl['collection-editor'], 'seriesEditor'),
        ...this.buildCreators(csl['container-author'], 'bookAuthor'),
        ...this.buildCreators(csl.director, 'director'),
        ...this.buildCreators(csl.composer, 'composer'),
        ...this.buildCreators(csl.interviewer, 'interviewer'),
        ...this.buildCreators(csl.recipient, 'recipient'),
        ...this.buildCreators(csl['reviewed-author'], 'reviewedAuthor'),
        ...this.buildCreators(csl.contributor, 'contributor'),
      ];

      const issued = csl.issued as
        | {
            'date-parts'?: (number | string)[][];
            raw?: string;
            literal?: string;
          }
        | undefined;
      const year =
        issued?.['date-parts']?.[0]?.[0] != null
          ? Number(issued['date-parts'][0][0])
          : undefined;
      const publicationDate = this.formatDateParts(issued);

      const accessed = csl.accessed as
        | {
            'date-parts'?: (number | string)[][];
            raw?: string;
            literal?: string;
          }
        | undefined;
      const accessedAt = this.formatDateParts(accessed);

      const keywords = this.extractKeywords(
        csl._keywords || csl.keyword || csl.keywords || csl.subject,
      );

      const numPages = toOptStr(csl['number-of-pages']);
      const numberOfVolumes = toOptStr(csl['number-of-volumes']);
      const seriesNumber = toOptStr(csl['collection-number']);
      const chapterNumber = toOptStr(csl['chapter-number']);

      const containerTitle =
        (csl['container-title'] as string)?.trim() || undefined;
      const publisher = (csl.publisher as string)?.trim() || undefined;
      const place = (csl['publisher-place'] as string)?.trim() || undefined;
      const eventPlace = (csl['event-place'] as string)?.trim() || undefined;
      const eventTitle =
        ((csl['event-title'] || csl.event) as string)?.trim() || undefined;
      const genre = (csl.genre as string)?.trim() || undefined;
      const numberVal = toOptStr(csl.number);
      const authority = (csl.authority as string)?.trim() || undefined;

      const shortTitle =
        ((csl['title-short'] || csl.shortTitle) as string)?.trim() || undefined;
      const journalAbbr =
        (
          (csl['container-title-short'] || csl.journalAbbreviation) as string
        )?.trim() || undefined;
      const section = (csl.section as string)?.trim() || undefined;
      const versionNumber = toOptStr(csl.version);
      const callNumber = (csl['call-number'] as string)?.trim() || undefined;
      const archive = (csl.archive as string)?.trim() || undefined;
      const archiveLocation =
        (csl['archive_location'] as string)?.trim() || undefined;
      const libraryCatalog = (csl.source as string)?.trim() || undefined;
      const note = (csl.note as string)?.trim() || undefined;
      const annote = (csl.annote as string)?.trim() || undefined;
      const parsedNotes: string[] = [];
      if (annote) parsedNotes.push(annote);
      if (Array.isArray(csl.notes)) {
        for (const n of csl.notes) {
          const text =
            typeof n === 'string'
              ? n.trim()
              : n && typeof n === 'object'
                ? toStr(
                    (n as { content?: unknown; note?: unknown }).content ??
                      (n as { note?: unknown }).note,
                  )
                : '';
          if (text && !parsedNotes.includes(text)) {
            parsedNotes.push(text);
          }
        }
      }

      let pmid =
        ((csl.PMID || csl.pmid) as string | number | undefined) != null
          ? String(csl.PMID || csl.pmid).trim()
          : undefined;
      let pmcid =
        ((csl.PMCID || csl.pmcid) as string | undefined)?.trim() || undefined;
      let arxivId =
        (
          (csl.arxivId || csl.arXiv || csl.eprint) as string | undefined
        )?.trim() || undefined;

      let cleanedExtraNote = note;
      if (note) {
        if (!pmid) {
          const m = note.match(/\bPMID\s*:\s*(\d{4,10})\b/i);
          if (m) pmid = m[1];
        }
        if (!pmcid) {
          const m =
            note.match(/\bPMCID\s*:\s*(PMC\d+)\b/i) ||
            note.match(/\b(PMC\d{4,12})\b/i);
          if (m) pmcid = m[1].toUpperCase();
        }
        if (!arxivId) {
          const m = note.match(/\barXiv\s*:\s*([^\s,;]+)/i);
          if (m) arxivId = m[1];
        }
        // Strip standalone identifier lines that were promoted to canonical fields
        const remainingLines = note
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(
            (l) =>
              Boolean(l) &&
              !/^(?:PMID\s*:\s*\d{4,10}|PMCID\s*:\s*PMC\d+|arXiv\s*:\s*[^\s,;]+(?:\s*\[[^\]]+\])?)$/i.test(
                l,
              ),
          );
        cleanedExtraNote =
          remainingLines.length > 0 ? remainingLines.join('\n') : undefined;
      }

      const university = itemType === 'thesis' ? publisher : undefined;
      const thesisType = itemType === 'thesis' ? genre : undefined;
      const institution = itemType === 'report' ? publisher : undefined;
      const reportNumber = itemType === 'report' ? numberVal : undefined;
      const reportType = itemType === 'report' ? genre : undefined;
      const issuingAuthority =
        itemType === 'patent' ? authority || publisher : authority;
      const patentNumber = itemType === 'patent' ? numberVal : undefined;
      const proceedingsTitle =
        itemType === 'conferencePaper' ? containerTitle : undefined;
      const conferenceName = eventTitle;
      const bookTitle = itemType === 'bookSection' ? containerTitle : undefined;

      const extraFields: Record<string, unknown> = {
        ...(numPages
          ? {
              numberOfPages: Number(numPages) || numPages,
              numPages: Number(numPages) || numPages,
            }
          : {}),
        ...(numberOfVolumes ? { numberOfVolumes } : {}),
        ...(seriesNumber ? { seriesNumber } : {}),
        ...(chapterNumber ? { chapterNumber, chapter: chapterNumber } : {}),
        ...(shortTitle ? { shortTitle } : {}),
        ...(journalAbbr
          ? { journalAbbr, journalAbbreviation: journalAbbr }
          : {}),
        ...(section ? { section } : {}),
        ...(versionNumber ? { versionNumber } : {}),
        ...(callNumber ? { callNumber } : {}),
        ...(archive ? { archive } : {}),
        ...(archiveLocation ? { archiveLocation } : {}),
        ...(libraryCatalog ? { libraryCatalog } : {}),
        ...(eventPlace ? { eventPlace } : {}),
        ...(conferenceName ? { conferenceName } : {}),
        ...(proceedingsTitle ? { proceedingsTitle } : {}),
        ...(bookTitle ? { bookTitle } : {}),
        ...(university ? { university } : {}),
        ...(thesisType ? { thesisType } : {}),
        ...(institution ? { institution } : {}),
        ...(reportNumber ? { reportNumber } : {}),
        ...(reportType ? { reportType } : {}),
        ...(issuingAuthority
          ? { issuingAuthority, authority: issuingAuthority }
          : {}),
        ...(patentNumber ? { patentNumber } : {}),
        ...(genre ? { genre } : {}),
        ...(numberVal ? { number: numberVal } : {}),
        ...(accessedAt ? { accessedAt, accessDate: accessedAt } : {}),
        ...(publicationDate ? { publicationDate, date: publicationDate } : {}),
        ...(pmid ? { pmid } : {}),
        ...(pmcid ? { pmcid } : {}),
        ...(arxivId ? { arxivId } : {}),
      };

      results.push({
        title: (csl.title as string) || 'Untitled Document',
        itemType,
        authors: authors.length > 0 ? authors : undefined,
        editors: editors.length > 0 ? editors : undefined,
        creators: creators.length > 0 ? creators : undefined,
        year,
        publicationDate,
        accessedAt,
        publicationTitle: containerTitle,
        journal: containerTitle,
        journalAbbr,
        shortTitle,
        publisher,
        place: place || eventPlace,
        eventPlace,
        conferenceName,
        proceedingsTitle,
        bookTitle,
        university,
        thesisType,
        institution,
        reportNumber,
        reportType,
        issuingAuthority,
        patentNumber,
        volume: toOptStr(csl.volume),
        issue: toOptStr(csl.issue),
        pages: (csl.page as string) || undefined,
        numPages,
        numberOfVolumes,
        series: (csl['collection-title'] as string) || undefined,
        seriesNumber,
        edition: toOptStr(csl.edition),
        section,
        versionNumber,
        callNumber,
        archive,
        archiveLocation,
        libraryCatalog,
        doi: ((csl.DOI || csl.doi) as string) || undefined,
        pmid,
        pmcid,
        arxivId,
        isbn: ((csl.ISBN || csl.isbn) as string) || undefined,
        issn: ((csl.ISSN || csl.issn) as string) || undefined,
        url: ((csl.URL || csl.url) as string) || undefined,
        abstract: (csl.abstract as string) || undefined,
        citationKey: ((csl.id || csl['citation-key']) as string) || undefined,
        tags: keywords,
        keywords,
        notes: parsedNotes.length > 0 ? parsedNotes : undefined,
        language: toOptStr(csl.language),
        rights: toOptStr(csl.rights),
        extra: cleanedExtraNote,
        extraFields:
          Object.keys(extraFields).length > 0 ? extraFields : undefined,
      });
    }

    return results;
  }

  private formatDateParts(
    dateObj:
      | { 'date-parts'?: (number | string)[][]; raw?: string; literal?: string }
      | undefined,
  ): string | undefined {
    if (!dateObj || typeof dateObj !== 'object') return undefined;
    const parts = dateObj['date-parts']?.[0];
    if (Array.isArray(parts) && parts.length > 0 && parts[0] != null) {
      const y = String(parts[0]).trim();
      if (!y) return undefined;
      if (parts.length === 1 || parts[1] == null) return y;
      const m = String(parts[1]).trim().padStart(2, '0');
      if (parts.length === 2 || parts[2] == null) return `${y}-${m}`;
      const d = String(parts[2]).trim().padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    const fallback = dateObj.raw || dateObj.literal;
    return typeof fallback === 'string' && fallback.trim()
      ? fallback.trim()
      : undefined;
  }

  private extractPeople(people: unknown): string[] {
    if (!Array.isArray(people)) return [];
    const toStr = (v: unknown) =>
      typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
    return people
      .map((p: unknown) => {
        if (!p || typeof p !== 'object') return '';
        const rec = p as Record<string, unknown>;
        const literal = toStr(rec.literal);
        if (literal) return literal;
        const given = toStr(rec.given);
        const family = toStr(rec.family);
        if (given && family) return `${given} ${family}`.trim();
        return family || given || '';
      })
      .filter(Boolean);
  }

  private buildCreators(
    people: unknown,
    creatorType: string,
  ): Array<{
    name: string;
    fullName?: string;
    firstName?: string;
    lastName?: string;
    creatorType: string;
    fieldMode?: number;
  }> {
    if (!Array.isArray(people)) return [];
    const toStr = (v: unknown) =>
      typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
    return people
      .map((p: unknown) => {
        if (!p || typeof p !== 'object') return null;
        const rec = p as Record<string, unknown>;
        const literal = toStr(rec.literal);
        const rawGiven = toStr(rec.given);
        const rawFamily = toStr(rec.family);
        if (literal && !rawGiven && !rawFamily) {
          return {
            name: literal,
            fullName: literal,
            firstName: '',
            lastName: literal,
            creatorType,
            fieldMode: 1,
          };
        }
        const nonDropping = toStr(rec['non-dropping-particle']);
        const dropping = toStr(rec['dropping-particle']);
        const prefix = nonDropping
          ? `${nonDropping} `
          : dropping
            ? `${dropping} `
            : '';
        const suffixStr = toStr(rec.suffix);
        const suffix = suffixStr ? ` ${suffixStr}` : '';
        const family = rawFamily ? `${prefix}${rawFamily}${suffix}`.trim() : '';
        const given = rawGiven;
        const name =
          literal ||
          (given && family ? `${given} ${family}` : family || given || '');
        if (!name) return null;
        const cleanName = name.trim();
        return {
          name: cleanName,
          fullName: cleanName,
          firstName: given || undefined,
          lastName: family || undefined,
          creatorType,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
  }

  private extractKeywords(raw: unknown): string[] | undefined {
    if (Array.isArray(raw)) {
      const list = normalizeAcademicTags(
        raw.map((k) =>
          typeof k === 'string' || typeof k === 'object'
            ? (k as string)
            : String(k),
        ),
      );
      return list.length > 0 ? list : undefined;
    }
    if (typeof raw === 'string' && raw.trim()) {
      const list = normalizeAcademicTags([raw]);
      return list.length > 0 ? list : undefined;
    }
    return undefined;
  }
}
