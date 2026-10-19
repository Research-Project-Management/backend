import {
  cleanAbstractText,
  normalizeDoi,
  parseCreatorString,
} from '@/modules/library/core';
import { normalizeAcademicTags } from '@/modules/library/core/domain/tag.domain';
import { CreatorInput } from '@/modules/library/ingestion/types/metadata.types';
import { RisItem } from './ris.parser';

export const RIS_TYPE_MAP: Record<string, string> = {
  JOUR: 'journalArticle',
  JFULL: 'journalArticle',
  ABST: 'journalArticle',
  BOOK: 'book',
  SER: 'book',
  CONF: 'conferencePaper',
  CPAPER: 'conferencePaper',
  PROJ: 'conferencePaper',
  THES: 'thesis',
  RPRT: 'report',
  REPORT: 'report',
  CHAP: 'bookSection',
  PAMP: 'document',
  PAT: 'patent',
  DATA: 'dataset',
  COMP: 'computerProgram',
  ELEC: 'webpage',
  WEB: 'webpage',
  ICOMM: 'webpage',
  MGZN: 'magazineArticle',
  NEWS: 'newspaperArticle',
  CASE: 'case',
  STAT: 'statute',
  BILL: 'bill',
  HEAR: 'hearing',
  GEN: 'document',
  MANSCPT: 'manuscript',
  UNPB: 'manuscript',
  MAP: 'map',
  SOUND: 'audioRecording',
  MPCT: 'film',
  VIDEO: 'videoRecording',
};

export function mapRisTypeToItemType(risType: string): string {
  const upper = (risType || '').toUpperCase().trim();
  return RIS_TYPE_MAP[upper] || 'journalArticle';
}

export function extractIdentifiersFromText(
  tag: string,
  val: string,
  isPubMedDb?: boolean,
): { pmid?: string; pmcid?: string; arxivId?: string } {
  const pmcMatch = val.match(/\b(PMC\d{5,12})\b/i);
  const pmcid = pmcMatch ? pmcMatch[1].toUpperCase() : undefined;

  let pmid: string | undefined;
  const pmidMatch = val.match(/PMID[:\s]*(\d{5,10})\b/i);
  if (pmidMatch) {
    pmid = pmidMatch[1];
  } else if (
    tag === 'AN' &&
    (isPubMedDb || /^\d{7,9}$/.test(val)) &&
    /^\d{6,10}$/.test(val)
  ) {
    pmid = val;
  }

  const axMatch = val.match(/arXiv[:\s/]*(\d{4}\.\d{4,5}(?:v\d+)?)/i);
  const arxivId = axMatch ? axMatch[1] : undefined;

  return { pmid, pmcid, arxivId };
}

export function buildTypeSpecificFields(params: {
  itemType: string;
  publisher?: string;
  rawM1?: string;
  rawM3?: string;
  rawU1?: string;
  rawIs?: string;
  rawSn?: string;
  rawT2?: string;
  rawC3?: string;
}) {
  const {
    itemType,
    publisher,
    rawM1,
    rawM3,
    rawU1,
    rawIs,
    rawSn,
    rawT2,
    rawC3,
  } = params;
  const university = itemType === 'thesis' ? publisher || undefined : undefined;
  const thesisType =
    itemType === 'thesis' ? rawM3 || rawU1 || undefined : undefined;
  const institution =
    itemType === 'report' ? publisher || undefined : undefined;
  const reportNumber =
    itemType === 'report' ? rawM1 || rawIs || undefined : undefined;
  const patentNumber =
    itemType === 'patent' ? rawM1 || rawIs || rawSn || undefined : undefined;
  const bookTitle = itemType === 'bookSection' ? rawT2 || undefined : undefined;
  const proceedingsTitle =
    itemType === 'conferencePaper' ? rawT2 || undefined : undefined;
  const conferenceName =
    itemType === 'conferencePaper' ? rawC3 || undefined : undefined;

  const extraFields: Record<string, unknown> = {
    ...(university ? { university } : {}),
    ...(institution ? { institution } : {}),
    ...(thesisType ? { thesisType } : {}),
    ...(reportNumber ? { reportNumber } : {}),
    ...(patentNumber ? { patentNumber } : {}),
    ...(bookTitle ? { bookTitle } : {}),
    ...(proceedingsTitle ? { proceedingsTitle } : {}),
    ...(conferenceName ? { conferenceName } : {}),
  };

  return {
    university,
    institution,
    thesisType,
    reportNumber,
    patentNumber,
    bookTitle,
    proceedingsTitle,
    conferenceName,
    extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
  };
}

export interface FallbackRisRecord {
  itemType: string;
  rawAuthors: string[];
  rawEditors?: string[];
  rawTags: string[];
  rawNotes?: string[];
  title?: string;
  shortTitle?: string;
  year?: number;
  accessedAt?: string;
  publicationTitle?: string;
  journal?: string;
  journalAbbr?: string;
  volume?: string;
  issue?: string;
  startPage?: string;
  endPage?: string;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  arxivId?: string;
  publisher?: string;
  place?: string;
  language?: string;
  issn?: string;
  isbn?: string;
  url?: string;
  edition?: string;
  callNumber?: string;
  archive?: string;
  series?: string;
  abstract?: string;
  rawSn?: string;
  rawM1?: string;
  rawM3?: string;
  rawU1?: string;
  rawC3?: string;
  isPubMedDb?: boolean;
}

export class RisFallbackParser {
  /**
   * Resilient line-by-line parser for non-standard RIS dialect variations
   */
  static parse(content: string): RisItem[] {
    return this.parseRawRecords(content).map((rec) =>
      this.finalizeRecord(rec),
    );
  }

  /**
   * Parses raw RIS content into intermediate FallbackRisRecord objects.
   */
  static parseRawRecords(content: string): FallbackRisRecord[] {
    const lines = content.split(/\r?\n/);
    const records: FallbackRisRecord[] = [];
    let currentRecord: FallbackRisRecord | null = null;
    let lastTag = '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      const match = rawLine.match(/^([A-Z0-9]{2,4})\s*-\s*(.*)$/);
      if (!match) {
        if (currentRecord && line) {
          if (lastTag === 'AB' || lastTag === 'N2') {
            currentRecord.abstract =
              (currentRecord.abstract ? currentRecord.abstract + '\n' : '') +
              line;
          } else if (
            (lastTag === 'RN' || lastTag === 'N1') &&
            currentRecord.rawNotes &&
            currentRecord.rawNotes.length > 0
          ) {
            const lastIdx = currentRecord.rawNotes.length - 1;
            currentRecord.rawNotes[lastIdx] += ' ' + line;
          } else if (
            (lastTag === 'TI' || lastTag === 'T1') &&
            currentRecord.title
          ) {
            currentRecord.title += ' ' + line;
          }
        }
        continue;
      }

      const [, tag, val] = match;
      const value = val.trim();
      lastTag = tag;

      if (tag === 'TY') {
        if (currentRecord) {
          records.push(currentRecord);
        }
        currentRecord = {
          itemType: mapRisTypeToItemType(value),
          rawAuthors: [],
          rawEditors: [],
          rawTags: [],
          rawNotes: [],
        };
        continue;
      }

      if (tag === 'ER') {
        if (currentRecord) {
          records.push(currentRecord);
          currentRecord = null;
        }
        continue;
      }

      if (!currentRecord) continue;

      switch (tag) {
        case 'TI':
        case 'T1':
          currentRecord.title = value;
          break;
        case 'ST':
          currentRecord.shortTitle = value;
          break;
        case 'AU':
        case 'A1':
          currentRecord.rawAuthors.push(value);
          break;
        case 'ED':
        case 'A2':
          if (!currentRecord.rawEditors) currentRecord.rawEditors = [];
          currentRecord.rawEditors.push(value);
          break;
        case 'PY':
        case 'Y1':
        case 'DA': {
          const yearMatch = value.match(/\b(19|20)\d{2}\b/);
          if (yearMatch) currentRecord.year = parseInt(yearMatch[0], 10);
          break;
        }
        case 'Y2':
          currentRecord.accessedAt = value.replace(/\//g, '-');
          break;
        case 'JO':
        case 'JF':
        case 'T2':
        case 'BT':
          currentRecord.publicationTitle = value;
          currentRecord.journal = value;
          break;
        case 'J2':
        case 'JA':
          currentRecord.journalAbbr = value;
          break;
        case 'VL':
          currentRecord.volume = value;
          break;
        case 'IS':
          currentRecord.issue = value;
          break;
        case 'SP':
          currentRecord.startPage = value;
          break;
        case 'EP':
          currentRecord.endPage = value;
          break;
        case 'DO':
          currentRecord.doi = value;
          break;
        case 'PB':
        case 'INST':
          currentRecord.publisher = value;
          break;
        case 'CY':
        case 'AD':
          currentRecord.place = value;
          break;
        case 'LA':
          currentRecord.language = value;
          break;
        case 'SN':
          currentRecord.rawSn = value;
          if (value.replace(/[^0-9X]/gi, '').length === 8) {
            currentRecord.issn = value;
          } else {
            currentRecord.isbn = value;
          }
          break;
        case 'M1':
          currentRecord.rawM1 = value;
          break;
        case 'M3': {
          currentRecord.rawM3 = value;
          const ids = extractIdentifiersFromText(
            tag,
            value,
            currentRecord.isPubMedDb,
          );
          if (ids.pmcid && !currentRecord.pmcid) currentRecord.pmcid = ids.pmcid;
          if (ids.pmid && !currentRecord.pmid) currentRecord.pmid = ids.pmid;
          if (ids.arxivId && !currentRecord.arxivId) {
            currentRecord.arxivId = ids.arxivId;
          }
          break;
        }
        case 'U1':
          currentRecord.rawU1 = value;
          break;
        case 'C3':
          currentRecord.rawC3 = value;
          break;
        case 'DB':
          if (/pubmed|medline|ncbi/i.test(value)) {
            currentRecord.isPubMedDb = true;
          }
          break;
        case 'AN':
        case 'C2': {
          const ids = extractIdentifiersFromText(
            tag,
            value,
            currentRecord.isPubMedDb,
          );
          if (ids.pmcid) currentRecord.pmcid = ids.pmcid;
          if (ids.pmid) currentRecord.pmid = ids.pmid;
          if (ids.arxivId && !currentRecord.arxivId) {
            currentRecord.arxivId = ids.arxivId;
          }
          break;
        }
        case 'UR':
        case 'L1': {
          if (!currentRecord.url) currentRecord.url = value;
          const ids = extractIdentifiersFromText(tag, value);
          if (ids.arxivId && !currentRecord.arxivId) {
            currentRecord.arxivId = ids.arxivId;
          }
          break;
        }
        case 'ET':
          currentRecord.edition = value;
          break;
        case 'CN':
        case 'CA':
        case 'C1':
          currentRecord.callNumber = value;
          break;
        case 'L4':
          currentRecord.archive = value;
          break;
        case 'T3':
        case 'SE':
          currentRecord.series = value;
          if (!currentRecord.rawC3) currentRecord.rawC3 = value;
          break;
        case 'KW':
          currentRecord.rawTags.push(value);
          break;
        case 'RN':
        case 'N1': {
          if (!currentRecord.rawNotes) currentRecord.rawNotes = [];
          currentRecord.rawNotes.push(value);
          const ids = extractIdentifiersFromText(tag, value);
          if (ids.pmcid && !currentRecord.pmcid) {
            currentRecord.pmcid = ids.pmcid;
          }
          if (ids.pmid && !currentRecord.pmid) {
            currentRecord.pmid = ids.pmid;
          }
          if (ids.arxivId && !currentRecord.arxivId) {
            currentRecord.arxivId = ids.arxivId;
          }
          break;
        }
        case 'AB':
        case 'N2':
          currentRecord.abstract =
            (currentRecord.abstract ? currentRecord.abstract + ' ' : '') +
            value;
          break;
      }
    }

    if (currentRecord) {
      records.push(currentRecord);
    }

    return records;
  }

  static finalizeRecord(record: FallbackRisRecord): RisItem {
    const creators: CreatorInput[] = [];
    for (let i = 0; i < record.rawAuthors.length; i++) {
      const parsed = parseCreatorString(record.rawAuthors[i], i, 'author');
      creators.push({
        lastName: parsed.lastName,
        firstName: parsed.firstName || undefined,
        fullName: parsed.fullName,
        creatorType: 'author',
        ...(parsed.fieldMode === 1 ? { fieldMode: 1 } : {}),
      });
    }

    if (record.rawEditors && record.rawEditors.length > 0) {
      for (let i = 0; i < record.rawEditors.length; i++) {
        const parsed = parseCreatorString(
          record.rawEditors[i],
          creators.length,
          'editor',
        );
        creators.push({
          lastName: parsed.lastName,
          firstName: parsed.firstName || undefined,
          fullName: parsed.fullName,
          creatorType: 'editor',
          ...(parsed.fieldMode === 1 ? { fieldMode: 1 } : {}),
        });
      }
    }

    let pages: string | undefined;
    if (record.startPage && record.endPage) {
      pages = `${record.startPage}-${record.endPage}`;
    } else {
      pages = record.startPage || record.endPage;
    }

    const tags = normalizeAcademicTags(record.rawTags);

    const consolidatedNotes: Array<{ content: string; source?: string }> = [];
    const seenNotes = new Set<string>();
    if (record.rawNotes && record.rawNotes.length > 0) {
      for (const noteContent of record.rawNotes) {
        const trimmed = noteContent.trim();
        if (trimmed && !seenNotes.has(trimmed.toLowerCase())) {
          seenNotes.add(trimmed.toLowerCase());
          consolidatedNotes.push({ content: trimmed, source: 'ris_note' });
        }
      }
    }

    const typeSpecific = buildTypeSpecificFields({
      itemType: record.itemType,
      publisher: record.publisher,
      rawM1: record.rawM1,
      rawM3: record.rawM3,
      rawU1: record.rawU1,
      rawIs: record.issue,
      rawSn: record.rawSn,
      rawT2: record.publicationTitle,
      rawC3: record.rawC3,
    });

    const doi = record.doi ? normalizeDoi(record.doi) || record.doi : undefined;

    return {
      itemType: record.itemType,
      title: record.title || 'Untitled Reference',
      shortTitle: record.shortTitle,
      authors: record.rawAuthors,
      creators,
      editors:
        record.rawEditors && record.rawEditors.length > 0
          ? record.rawEditors
          : undefined,
      year: record.year,
      publicationDate: record.year ? String(record.year) : undefined,
      journal: record.publicationTitle,
      publicationTitle: record.publicationTitle,
      journalAbbr: record.journalAbbr,
      publisher: record.publisher,
      ...typeSpecific,
      place: record.place,
      volume: record.volume,
      issue:
        record.itemType === 'report' || record.itemType === 'patent'
          ? undefined
          : record.issue,
      pages,
      doi,
      pmid: record.pmid,
      pmcid: record.pmcid,
      arxivId: record.arxivId,
      isbn: record.itemType === 'patent' ? undefined : record.isbn,
      issn: record.issn,
      url: record.url,
      accessedAt: record.accessedAt,
      abstract: cleanAbstractText(record.abstract),
      series: record.series,
      edition: record.edition,
      language: record.language,
      callNumber: record.callNumber,
      archive: record.archive,
      tags,
      keywords: tags,
      notes: consolidatedNotes.length > 0 ? consolidatedNotes : undefined,
    };
  }
}
