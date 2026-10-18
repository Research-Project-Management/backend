import { Injectable, Logger } from '@nestjs/common';
import {
  ItemMetadata,
  CreatorInput,
} from '@/modules/library/ingestion/types/metadata.types';
import { IngestionValidationException } from '@/modules/library/ingestion/types/ingestion.errors';
import {
  cleanAbstractText,
  mapCslTypeToZoteroItemType,
  normalizeDoi,
  parseCreatorString,
} from '@/modules/library/core';
import { normalizeAcademicTags } from '@/modules/library/core/domain/tag.domain';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Cite } = require('@citation-js/core');
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('@citation-js/plugin-ris');

export interface RisItem extends ItemMetadata {
  pmid?: string;
  pmcid?: string;
  shortTitle?: string;
  journalAbbr?: string;
  accessedAt?: string | Date | null;
  university?: string;
  institution?: string;
  bookTitle?: string;
  proceedingsTitle?: string;
  conferenceName?: string;
  reportNumber?: string;
  patentNumber?: string;
  thesisType?: string;
}

interface CslRisPerson {
  family?: string;
  given?: string;
  literal?: string;
}

interface CslRisItem {
  author?: CslRisPerson[];
  editor?: CslRisPerson[];
  keyword?: string | string[];
  issued?: {
    'date-parts'?: (number | string)[][];
  };
  type?: string;
  title?: string;
  'title-short'?: string;
  'container-title'?: string;
  'container-title-short'?: string;
  publisher?: string;
  'publisher-place'?: string;
  volume?: string | number;
  issue?: string | number;
  page?: string | number;
  DOI?: string;
  ISBN?: string;
  ISSN?: string;
  URL?: string;
  abstract?: string;
  'collection-title'?: string;
  edition?: string | number;
  language?: string;
  rights?: string;
  archive?: string;
  'call-number'?: string;
  note?: string;
  annote?: string;
  comment?: string;
  [key: string]: unknown;
}

@Injectable()
export class RisParser {
  private readonly logger = new Logger(RisParser.name);

  /**
   * Asynchronously parses raw RIS text using standard in-process citation parser.
   */
  async parseAsync(content: string): Promise<RisItem[]> {
    if (!content || typeof content !== 'string' || !content.trim()) {
      throw new IngestionValidationException(
        'RIS content must be a non-empty string',
      );
    }

    return this.parse(content);
  }

  /**
   * Parses a raw RIS string into one or more ItemMetadata objects using @citation-js engine.
   */
  parse(content: string): RisItem[] {
    if (!content || typeof content !== 'string' || !content.trim()) {
      throw new IngestionValidationException(
        'RIS content must be a non-empty string',
      );
    }

    try {
      const normalized = content.replace(/\r\n/g, '\n').trim();
      const rawRecords = normalized
        .split(/(?=^TY\s+-)/m)
        .map((r) => r.trim())
        .filter((r) => r.startsWith('TY'));

      const cite = new Cite(content);
      const data = cite.data || [];

      if (data.length === 0) {
        return this.fallbackParse(content);
      }

      return (data as CslRisItem[]).map((csl: CslRisItem, idx: number) => {
        const rawAuthors: string[] = [];
        const creators: CreatorInput[] = [];

        (csl.author || []).forEach((a: CslRisPerson) => {
          const family = a.family?.trim() || '';
          const given = a.given?.trim() || '';
          const fullName =
            a.literal?.trim() ||
            (family && given ? `${given} ${family}` : family || given);

          if (fullName) {
            rawAuthors.push(fullName);
            creators.push({
              firstName: given || undefined,
              lastName: family || undefined,
              fullName,
              creatorType: 'author',
              ...(a.literal && !family && !given ? { fieldMode: 1 } : {}),
            });
          }
        });

        const rawEditors: string[] = [];
        (csl.editor || []).forEach((e: CslRisPerson) => {
          const family = e.family?.trim() || '';
          const given = e.given?.trim() || '';
          const fullName =
            e.literal?.trim() ||
            (family && given ? `${given} ${family}` : family || given);

          if (fullName) {
            rawEditors.push(fullName);
            creators.push({
              firstName: given || undefined,
              lastName: family || undefined,
              fullName,
              creatorType: 'editor',
              ...(e.literal && !family && !given ? { fieldMode: 1 } : {}),
            });
          }
        });

        const currentRawRecord =
          rawRecords[idx] || (rawRecords.length === 1 ? rawRecords[0] : '');

        // Citation.js RIS plugin omits 'ED  -' (and sometimes variations of 'A2  -').
        // Enrich editors from the raw record so they are never dropped.
        if (currentRawRecord) {
          const editorMatches = [
            ...currentRawRecord.matchAll(/^(?:ED|A2)\s*-\s*(.+)$/gim),
          ];
          for (const m of editorMatches) {
            const edStr = m[1]?.trim();
            if (
              edStr &&
              !rawEditors.some(
                (existing) => existing.toLowerCase() === edStr.toLowerCase(),
              )
            ) {
              rawEditors.push(edStr);
              const parsed = parseCreatorString(
                edStr,
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
        }

        // Tags / keywords handling
        const rawKeywords: string[] = [];
        if (currentRawRecord) {
          const kwMatches = currentRawRecord.matchAll(/^(?:KW)\s*-\s*(.+)$/gim);
          for (const m of kwMatches) {
            if (m[1]?.trim()) {
              rawKeywords.push(m[1].trim());
            }
          }
        }
        if (rawKeywords.length === 0 && csl.keyword) {
          if (Array.isArray(csl.keyword)) {
            rawKeywords.push(
              ...csl.keyword.map((k: string) => k.trim()).filter(Boolean),
            );
          } else if (typeof csl.keyword === 'string') {
            rawKeywords.push(csl.keyword.trim());
          }
        }
        const tags = normalizeAcademicTags(rawKeywords);

        let year =
          csl.issued?.['date-parts']?.[0]?.[0] != null
            ? Number(csl.issued['date-parts'][0][0])
            : undefined;
        if ((!year || Number.isNaN(year)) && currentRawRecord) {
          const pyMatch = currentRawRecord.match(
            /^(?:PY|Y1|DA)\s*-\s*.*?((?:19|20)\d{2})\b/im,
          );
          if (pyMatch) {
            year = parseInt(pyMatch[1], 10);
          } else {
            year = undefined;
          }
        }

        let itemType = this.mapCslTypeToItemType(csl.type || 'article-journal');
        if (currentRawRecord) {
          const tyMatch = currentRawRecord.match(/^TY\s*-\s*(\S+)/im);
          if (tyMatch?.[1]) {
            const rawRisType = this.mapRisTypeToItemType(tyMatch[1]);
            if (
              rawRisType === 'patent' ||
              rawRisType === 'thesis' ||
              rawRisType === 'report' ||
              rawRisType === 'bookSection' ||
              rawRisType === 'conferencePaper'
            ) {
              itemType = rawRisType;
            }
          }
        }

        // Notes extraction (including RN Research Notes and N1 Notes)
        const consolidatedNotes: Array<{ content: string; source?: string }> =
          [];
        const seenNotes = new Set<string>();

        const addNote = (text?: string | null, source: string = 'ris') => {
          if (!text || typeof text !== 'string') return;
          const trimmed = text.trim();
          if (trimmed && !seenNotes.has(trimmed)) {
            seenNotes.add(trimmed);
            consolidatedNotes.push({ content: trimmed, source });
          }
        };

        if (currentRawRecord) {
          const rnMatches = currentRawRecord.matchAll(
            /^(?:RN|N1)\s*-\s*(.+)$/gim,
          );
          for (const m of rnMatches) {
            addNote(m[1], 'ris');
          }
        }

        const rawNote = csl.note || csl.annote || csl.comment;
        addNote(typeof rawNote === 'string' ? rawNote : undefined, 'ris');

        const notes =
          consolidatedNotes.length > 0 ? consolidatedNotes : undefined;

        let archive = csl.archive || undefined;
        let callNumber = csl['call-number'] || undefined;
        let series = csl['collection-title'] || undefined;
        let edition = csl.edition ? String(csl.edition).trim() : undefined;
        let language = csl.language ? String(csl.language).trim() : undefined;
        let place = csl['publisher-place'] || undefined;
        let pages = csl.page ? String(csl.page).trim() : undefined;
        let shortTitle = csl['title-short']
          ? String(csl['title-short']).trim()
          : undefined;
        let journalAbbr = csl['container-title-short']
          ? String(csl['container-title-short']).trim()
          : undefined;
        let accessedAt: string | undefined;
        let pmid: string | undefined;
        let pmcid: string | undefined;
        let arxivId: string | undefined;
        let rawPublisher = csl.publisher
          ? String(csl.publisher).trim()
          : undefined;
        let rawM1: string | undefined;
        let rawM3: string | undefined;
        let rawU1: string | undefined;
        let rawSn: string | undefined;
        let rawIs: string | undefined = csl.issue
          ? String(csl.issue).trim()
          : undefined;
        let rawT2: string | undefined = csl['container-title']
          ? String(csl['container-title']).trim()
          : undefined;
        let rawC3: string | undefined;

        if (currentRawRecord) {
          if (!archive) {
            const l4Match = currentRawRecord.match(/^L4\s*-\s*(.+)$/m);
            if (l4Match) archive = l4Match[1].trim();
          }
          if (!callNumber) {
            const cnMatch = currentRawRecord.match(
              /^(?:CN|CA|C1)\s*-\s*(.+)$/m,
            );
            if (cnMatch) callNumber = cnMatch[1].trim();
          }
          if (!series) {
            const t3Match = currentRawRecord.match(/^(?:T3|SE)\s*-\s*(.+)$/m);
            if (t3Match) series = t3Match[1].trim();
          }
          if (!edition) {
            const etMatch = currentRawRecord.match(/^ET\s*-\s*(.+)$/m);
            if (etMatch) edition = etMatch[1].trim();
          }
          if (!language) {
            const laMatch = currentRawRecord.match(/^LA\s*-\s*(.+)$/m);
            if (laMatch) language = laMatch[1].trim();
          }
          if (!place) {
            const placeMatch = currentRawRecord.match(
              /^(?:CY|AD)\s*-\s*(.+)$/m,
            );
            if (placeMatch) place = placeMatch[1].trim();
          }
          const spMatch = currentRawRecord.match(/^SP\s*-\s*(.+)$/im);
          const epMatch = currentRawRecord.match(/^EP\s*-\s*(.+)$/im);
          const sp = spMatch?.[1]?.trim();
          const ep = epMatch?.[1]?.trim();
          if (sp || ep) {
            const combinedPages =
              sp && ep && sp !== ep ? `${sp}-${ep}` : sp || ep;
            if (!pages || (!pages.includes('-') && sp && ep && sp !== ep)) {
              pages = combinedPages;
            }
          }

          if (!shortTitle) {
            const stMatch = currentRawRecord.match(/^ST\s*-\s*(.+)$/im);
            if (stMatch) shortTitle = stMatch[1].trim();
          }
          if (!journalAbbr) {
            const j2Match = currentRawRecord.match(/^(?:J2|JA)\s*-\s*(.+)$/im);
            if (j2Match) journalAbbr = j2Match[1].trim();
          }
          const y2Match = currentRawRecord.match(/^Y2\s*-\s*(.+)$/im);
          if (y2Match?.[1]) {
            accessedAt = y2Match[1].trim().replace(/\//g, '-');
          }
          if (!rawPublisher) {
            const pbMatch = currentRawRecord.match(
              /^(?:PB|INST)\s*-\s*(.+)$/im,
            );
            if (pbMatch) rawPublisher = pbMatch[1].trim();
          }
          const m1Match = currentRawRecord.match(/^M1\s*-\s*(.+)$/im);
          if (m1Match) rawM1 = m1Match[1].trim();
          const m3Match = currentRawRecord.match(/^M3\s*-\s*(.+)$/im);
          if (m3Match) rawM3 = m3Match[1].trim();
          const u1Match = currentRawRecord.match(/^U1\s*-\s*(.+)$/im);
          if (u1Match) rawU1 = u1Match[1].trim();
          const snMatch = currentRawRecord.match(/^SN\s*-\s*(.+)$/im);
          if (snMatch) rawSn = snMatch[1].trim();
          if (!rawIs) {
            const isMatch = currentRawRecord.match(/^IS\s*-\s*(.+)$/im);
            if (isMatch) rawIs = isMatch[1].trim();
          }
          const t2Match = currentRawRecord.match(
            /^(?:T2|BT|JO|JF)\s*-\s*(.+)$/im,
          );
          if (t2Match) rawT2 = t2Match[1].trim();
          const c3Match = currentRawRecord.match(/^(?:C3|T3)\s*-\s*(.+)$/im);
          if (c3Match) rawC3 = c3Match[1].trim();

          // Identifier extraction from AN, C2, M3, N1, UR, DB
          const dbMatch = currentRawRecord.match(/^DB\s*-\s*(.+)$/im);
          const isPubMedDb = dbMatch
            ? /pubmed|medline|ncbi/i.test(dbMatch[1])
            : false;
          const idLines = [
            ...currentRawRecord.matchAll(/^(?:AN|C2|M3|N1|UR)\s*-\s*(.+)$/gim),
          ].map((m) => ({
            tag: m[0].slice(0, 2).toUpperCase(),
            val: m[1].trim(),
          }));

          for (const { tag, val } of idLines) {
            const extracted = this.extractIdentifiersFromText(
              tag,
              val,
              isPubMedDb,
            );
            if (!pmcid && extracted.pmcid) pmcid = extracted.pmcid;
            if (!pmid && extracted.pmid) pmid = extracted.pmid;
            if (!arxivId && extracted.arxivId) arxivId = extracted.arxivId;
          }
        }

        let rawDoi = csl.DOI || undefined;
        if (!rawDoi && currentRawRecord) {
          const doMatch = currentRawRecord.match(/^DO\s*-\s*(.+)$/im);
          if (doMatch) rawDoi = doMatch[1].trim();
        }
        const doi = rawDoi ? normalizeDoi(rawDoi) || rawDoi : undefined;

        const typeSpecific = this.buildTypeSpecificFields({
          itemType,
          publisher: rawPublisher,
          rawM1,
          rawM3,
          rawU1,
          rawIs,
          rawSn,
          rawT2,
          rawC3,
        });

        return {
          itemType,
          title: (csl.title || 'Untitled Reference').trim(),
          shortTitle,
          authors: rawAuthors,
          creators,
          editors: rawEditors.length > 0 ? rawEditors : undefined,
          year,
          publicationDate: year ? String(year) : undefined,
          journal: rawT2,
          publicationTitle: rawT2,
          journalAbbr,
          publisher: rawPublisher,
          ...typeSpecific,
          place,
          volume: csl.volume ? String(csl.volume) : undefined,
          issue:
            itemType === 'report' || itemType === 'patent' ? undefined : rawIs,
          pages,
          doi,
          pmid,
          pmcid,
          arxivId,
          isbn: itemType === 'patent' ? undefined : csl.ISBN || undefined,
          issn: csl.ISSN || undefined,
          url: csl.URL || undefined,
          accessedAt,
          abstract: (() => {
            let rawAbstract = csl.abstract || undefined;
            if (currentRawRecord) {
              const abMatch = currentRawRecord.match(
                /^(?:AB|N2)\s*-\s*([\s\S]*?)(?=\n[A-Z0-9]{2}\s*-|$)/im,
              );
              if (abMatch) {
                const fullRawAb = abMatch[1].trim();
                if (
                  !rawAbstract ||
                  fullRawAb.replace(/\s+/g, ' ').length >
                    rawAbstract.replace(/\s+/g, ' ').length
                ) {
                  rawAbstract = fullRawAb;
                }
              }
            }
            return cleanAbstractText(rawAbstract);
          })(),
          series,
          edition,
          language,
          rights: csl.rights ? String(csl.rights).trim() : undefined,
          callNumber,
          archive,
          tags,
          keywords: tags,
          notes,
        };
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Citation.js RIS parser error: ${errMsg}. Falling back to manual line parser.`,
      );
      return this.fallbackParse(content);
    }
  }

  private extractIdentifiersFromText(
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

  private buildTypeSpecificFields(params: {
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
    const university =
      itemType === 'thesis' ? publisher || undefined : undefined;
    const thesisType =
      itemType === 'thesis' ? rawM3 || rawU1 || undefined : undefined;
    const institution =
      itemType === 'report' ? publisher || undefined : undefined;
    const reportNumber =
      itemType === 'report' ? rawM1 || rawIs || undefined : undefined;
    const patentNumber =
      itemType === 'patent' ? rawM1 || rawIs || rawSn || undefined : undefined;
    const bookTitle =
      itemType === 'bookSection' ? rawT2 || undefined : undefined;
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
      extraFields:
        Object.keys(extraFields).length > 0 ? extraFields : undefined,
    };
  }

  private mapCslTypeToItemType(cslType: string): string {
    return mapCslTypeToZoteroItemType(cslType);
  }

  private mapRisTypeToItemType(risType: string): string {
    const upper = (risType || '').toUpperCase().trim();
    const map: Record<string, string> = {
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
    return map[upper] || 'journalArticle';
  }

  /**
   * Resilient line-by-line parser for non-standard RIS dialect variations
   */
  private fallbackParse(content: string): RisItem[] {
    const lines = content.split(/\r?\n/);
    const records: RisItem[] = [];
    let currentRecord:
      | (Partial<RisItem> & {
          rawAuthors: string[];
          rawEditors?: string[];
          rawTags: string[];
          rawNotes?: string[];
          startPage?: string;
          endPage?: string;
          rawM1?: string;
          rawM3?: string;
          rawU1?: string;
          rawSn?: string;
          rawC3?: string;
          isPubMedDb?: boolean;
        })
      | null = null;
    let lastTag = '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      const match = rawLine.match(/^([A-Z0-9]{2,4})\s*-\s*(.*)$/);
      if (!match) {
        if (currentRecord && line) {
          if (lastTag === 'AB' || lastTag === 'N2') {
            currentRecord.abstract =
              (currentRecord.abstract ? currentRecord.abstract + ' ' : '') +
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
        currentRecord = {
          itemType: this.mapRisTypeToItemType(value),
          rawAuthors: [],
          rawEditors: [],
          rawTags: [],
          rawNotes: [],
        };
        continue;
      }

      if (tag === 'ER') {
        if (currentRecord) {
          records.push(this.finalizeRecord(currentRecord));
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
        case 'Y1': {
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
        case 'M3':
          currentRecord.rawM3 = value;
          break;
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
          const ids = this.extractIdentifiersFromText(
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
          const ids = this.extractIdentifiersFromText(tag, value);
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
          const ids = this.extractIdentifiersFromText(tag, value);
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
          currentRecord.abstract = value;
          break;
      }
    }

    if (currentRecord) {
      records.push(this.finalizeRecord(currentRecord));
    }

    return records;
  }

  private finalizeRecord(
    record: Partial<RisItem> & {
      rawAuthors: string[];
      rawEditors?: string[];
      rawTags: string[];
      rawNotes?: string[];
      startPage?: string;
      endPage?: string;
      rawM1?: string;
      rawM3?: string;
      rawU1?: string;
      rawSn?: string;
      rawC3?: string;
    },
  ): RisItem {
    const creators: CreatorInput[] = record.rawAuthors.map(
      (authorStr: string, idx: number) => {
        const parsed = parseCreatorString(authorStr, idx, 'author');
        return {
          lastName: parsed.lastName,
          firstName: parsed.firstName || undefined,
          fullName: parsed.fullName,
          creatorType: 'author',
          ...(parsed.fieldMode === 1 ? { fieldMode: 1 } : {}),
        };
      },
    );

    if (record.rawEditors && record.rawEditors.length > 0) {
      for (const editorStr of record.rawEditors) {
        const parsed = parseCreatorString(editorStr, creators.length, 'editor');
        creators.push({
          lastName: parsed.lastName,
          firstName: parsed.firstName || undefined,
          fullName: parsed.fullName,
          creatorType: 'editor',
          ...(parsed.fieldMode === 1 ? { fieldMode: 1 } : {}),
        });
      }
    }

    let pages = record.pages;
    if (!pages && (record.startPage || record.endPage)) {
      pages =
        record.startPage &&
        record.endPage &&
        record.startPage !== record.endPage
          ? `${record.startPage}-${record.endPage}`
          : record.startPage || record.endPage;
    }

    const itemType = record.itemType || 'journalArticle';
    const typeSpecific = this.buildTypeSpecificFields({
      itemType,
      publisher: record.publisher,
      rawM1: record.rawM1,
      rawM3: record.rawM3,
      rawU1: record.rawU1,
      rawIs: record.issue,
      rawSn: record.rawSn,
      rawT2: record.publicationTitle,
      rawC3: record.rawC3,
    });
    const normalizedTags = normalizeAcademicTags(record.rawTags);

    return {
      itemType,
      title: record.title || 'Untitled Reference',
      shortTitle: record.shortTitle,
      authors: record.rawAuthors,
      editors:
        record.rawEditors && record.rawEditors.length > 0
          ? record.rawEditors
          : undefined,
      creators,
      year: record.year,
      publicationDate: record.year ? String(record.year) : undefined,
      journal: record.journal,
      publicationTitle: record.publicationTitle,
      journalAbbr: record.journalAbbr,
      publisher: record.publisher,
      ...typeSpecific,
      place: record.place,
      volume: record.volume,
      issue:
        itemType === 'report' || itemType === 'patent'
          ? undefined
          : record.issue,
      pages,
      doi: record.doi ? normalizeDoi(record.doi) || record.doi : undefined,
      pmid: record.pmid,
      pmcid: record.pmcid,
      arxivId: record.arxivId,
      isbn: itemType === 'patent' ? undefined : record.isbn,
      issn: record.issn,
      url: record.url,
      accessedAt: record.accessedAt,
      language: record.language,
      edition: record.edition,
      callNumber: record.callNumber,
      archive: record.archive,
      series: record.series,
      tags: normalizedTags,
      keywords: normalizedTags,
      abstract: cleanAbstractText(record.abstract),
      notes:
        record.rawNotes && record.rawNotes.length > 0
          ? record.rawNotes.map((n: string) => ({ content: n, source: 'ris' }))
          : undefined,
    };
  }
}
