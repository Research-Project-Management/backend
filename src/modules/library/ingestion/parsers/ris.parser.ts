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
import {
  RisFallbackParser,
  mapRisTypeToItemType,
  extractIdentifiersFromText,
  buildTypeSpecificFields,
} from './ris-fallback.parser';

export {
  RisFallbackParser,
  mapRisTypeToItemType,
  extractIdentifiersFromText,
  buildTypeSpecificFields,
} from './ris-fallback.parser';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Cite } = require('@citation-js/core') as {
  Cite: new (input: string) => { data?: CslRisItem[] };
};
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
   * Parses a raw RIS string into one or more ItemMetadata objects using @citation-js engine,
   * enriched by RisFallbackParser.parseRawRecords for tags dropped by citation-js.
   */
  parse(content: string): RisItem[] {
    if (!content || typeof content !== 'string' || !content.trim()) {
      throw new IngestionValidationException(
        'RIS content must be a non-empty string',
      );
    }

    try {
      const cite = new Cite(content);
      const data = cite.data || [];

      if (data.length === 0) {
        return this.fallbackParse(content);
      }

      const rawRecordBlocks = this.splitRawRecordBlocks(content);

      return data.map((csl: CslRisItem, idx: number) => {
        const block =
          rawRecordBlocks[idx] ??
          (rawRecordBlocks.length === 1 ? rawRecordBlocks[0] : undefined);
        const rawRec =
          block && this.needsRawRecordEnrichment(csl, block)
            ? RisFallbackParser.parseRawRecords(block)[0]
            : undefined;

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
        const seenEditorKeys = new Set<string>();
        const registerEditor = (
          firstName?: string,
          lastName?: string,
          fullName?: string,
          displayStr?: string,
          fieldMode?: number,
        ) => {
          const cleanLast = (lastName || '').trim();
          const cleanFirst = (firstName || '').trim();
          const cleanFull = (
            fullName ||
            (cleanFirst && cleanLast
              ? `${cleanFirst} ${cleanLast}`
              : cleanLast || cleanFirst)
          ).trim();
          if (!cleanLast && !cleanFirst && !cleanFull) return;

          const normKey = `${cleanLast.toLowerCase()}|${cleanFirst.toLowerCase()}|${cleanFull.toLowerCase()}`;
          const altFull =
            cleanLast && cleanFirst
              ? `${cleanLast}, ${cleanFirst}`.toLowerCase()
              : cleanFull.toLowerCase();
          if (seenEditorKeys.has(normKey) || seenEditorKeys.has(altFull)) {
            return;
          }
          seenEditorKeys.add(normKey);
          seenEditorKeys.add(altFull);
          seenEditorKeys.add(cleanFull.toLowerCase());

          rawEditors.push((displayStr || cleanFull).trim());
          creators.push({
            firstName: cleanFirst || undefined,
            lastName: cleanLast || undefined,
            fullName: cleanFull,
            creatorType: 'editor',
            ...(fieldMode === 1 ? { fieldMode: 1 } : {}),
          });
        };

        (csl.editor || []).forEach((e: CslRisPerson) => {
          const family = e.family?.trim() || '';
          const given = e.given?.trim() || '';
          const literal = e.literal?.trim() || '';
          const fullName =
            literal ||
            (family && given ? `${given} ${family}` : family || given);

          if (fullName) {
            registerEditor(
              given || undefined,
              family || undefined,
              fullName,
              fullName,
              literal && !family && !given ? 1 : undefined,
            );
          }
        });

        for (const edStr of rawRec?.rawEditors || []) {
          const cleanEdStr = edStr?.trim();
          if (!cleanEdStr) continue;
          const parsed = parseCreatorString(
            cleanEdStr,
            creators.length,
            'editor',
          );
          registerEditor(
            parsed.firstName || undefined,
            parsed.lastName || undefined,
            parsed.fullName || cleanEdStr,
            cleanEdStr,
            parsed.fieldMode === 1 ? 1 : undefined,
          );
        }

        const rawKeywords: string[] = [...(rawRec?.rawTags || [])];
        if (csl.keyword) {
          if (Array.isArray(csl.keyword)) {
            rawKeywords.push(
              ...csl.keyword.map((k: string) => String(k).trim()).filter(Boolean),
            );
          } else if (typeof csl.keyword === 'string') {
            rawKeywords.push(csl.keyword.trim());
          }
        }
        const tags = normalizeAcademicTags(rawKeywords);

        const dateParts = csl.issued?.['date-parts']?.[0];
        let year =
          dateParts?.[0] != null ? Number(dateParts[0]) : undefined;
        if (!year || Number.isNaN(year)) {
          year = rawRec?.year;
        }

        let cslPubDate: string | undefined;
        if (Array.isArray(dateParts) && dateParts[0] != null && !Number.isNaN(Number(dateParts[0]))) {
          const yStr = String(dateParts[0]).padStart(4, '0');
          const mNum = dateParts[1] != null ? Number(dateParts[1]) : undefined;
          const dNum = dateParts[2] != null ? Number(dateParts[2]) : undefined;
          if (mNum && mNum >= 1 && mNum <= 12) {
            const mStr = String(mNum).padStart(2, '0');
            if (dNum && dNum >= 1 && dNum <= 31) {
              cslPubDate = `${yStr}-${mStr}-${String(dNum).padStart(2, '0')}`;
            } else {
              cslPubDate = `${yStr}-${mStr}`;
            }
          } else {
            cslPubDate = yStr;
          }
        }
        const rawPubDate = rawRec?.publicationDate;
        const publicationDate =
          rawPubDate && (!cslPubDate || rawPubDate.length >= cslPubDate.length)
            ? rawPubDate
            : cslPubDate || (year ? String(year) : undefined);

        let itemType = this.mapCslTypeToItemType(csl.type || 'article-journal');
        const rawRisType = rawRec?.itemType;
        if (
          rawRisType === 'patent' ||
          rawRisType === 'thesis' ||
          rawRisType === 'report' ||
          rawRisType === 'bookSection' ||
          rawRisType === 'conferencePaper'
        ) {
          itemType = rawRisType;
        }

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
        for (const n of rawRec?.rawNotes || []) {
          addNote(n, 'ris');
        }
        const rawNote = csl.note || csl.annote || csl.comment;
        addNote(typeof rawNote === 'string' ? rawNote : undefined, 'ris');
        const notes =
          consolidatedNotes.length > 0 ? consolidatedNotes : undefined;

        const sp = rawRec?.startPage;
        const ep = rawRec?.endPage;
        const combinedRawPages =
          sp && ep && sp !== ep ? `${sp}-${ep}` : sp || ep;
        const cslPages = csl.page ? String(csl.page).trim() : undefined;
        const pages =
          !cslPages || (!cslPages.includes('-') && sp && ep && sp !== ep)
            ? combinedRawPages || cslPages
            : cslPages;

        const rawPublisher =
          (csl.publisher ? String(csl.publisher).trim() : undefined) ||
          rawRec?.publisher;
        const rawIs =
          (csl.issue ? String(csl.issue).trim() : undefined) || rawRec?.issue;
        const rawT2 =
          rawRec?.publicationTitle ||
          (csl['container-title']
            ? String(csl['container-title']).trim()
            : undefined);
        const rawC3 = rawRec?.rawC3;
        const rawDoi = csl.DOI || rawRec?.doi || undefined;
        const doi = rawDoi ? normalizeDoi(rawDoi) || rawDoi : undefined;

        const typeSpecific = this.buildTypeSpecificFields({
          itemType,
          publisher: rawPublisher,
          rawM1: rawRec?.rawM1,
          rawM3: rawRec?.rawM3,
          rawU1: rawRec?.rawU1,
          rawIs,
          rawSn: rawRec?.rawSn,
          rawT2,
          rawC3,
        });

        const cslAbstract = csl.abstract || undefined;
        const rawRecAbstract = rawRec?.abstract;
        const rawAbstract =
          rawRecAbstract &&
          (!cslAbstract ||
            rawRecAbstract.replace(/\s+/g, ' ').length >
              cslAbstract.replace(/\s+/g, ' ').length)
            ? rawRecAbstract
            : cslAbstract;

        return {
          itemType,
          title: (csl.title || rawRec?.title || 'Untitled Reference').trim(),
          shortTitle:
            (csl['title-short']
              ? String(csl['title-short']).trim()
              : undefined) || rawRec?.shortTitle,
          authors: rawAuthors,
          creators,
          editors: rawEditors.length > 0 ? rawEditors : undefined,
          year,
          publicationDate,
          journal: rawT2,
          publicationTitle: rawT2,
          journalAbbr:
            (csl['container-title-short']
              ? String(csl['container-title-short']).trim()
              : undefined) || rawRec?.journalAbbr,
          publisher: rawPublisher,
          ...typeSpecific,
          place: csl['publisher-place'] || rawRec?.place || undefined,
          volume: csl.volume ? String(csl.volume) : rawRec?.volume,
          issue:
            itemType === 'report' || itemType === 'patent' ? undefined : rawIs,
          pages,
          doi,
          pmid: rawRec?.pmid,
          pmcid: rawRec?.pmcid,
          arxivId: rawRec?.arxivId,
          isbn:
            itemType === 'patent'
              ? undefined
              : csl.ISBN || rawRec?.isbn || undefined,
          issn: csl.ISSN || rawRec?.issn || undefined,
          url: csl.URL || rawRec?.url || undefined,
          accessedAt: rawRec?.accessedAt,
          abstract: cleanAbstractText(rawAbstract),
          series: csl['collection-title'] || rawRec?.series || undefined,
          edition:
            (csl.edition ? String(csl.edition).trim() : undefined) ||
            rawRec?.edition,
          language:
            (csl.language ? String(csl.language).trim() : undefined) ||
            rawRec?.language,
          rights: csl.rights ? String(csl.rights).trim() : undefined,
          callNumber: csl['call-number'] || rawRec?.callNumber || undefined,
          archive: csl.archive || rawRec?.archive || undefined,
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

  private splitRawRecordBlocks(content: string): string[] {
    const blocks: string[] = [];
    const regex = /TY\s*-[\s\S]*?(?:ER\s*-|$)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      blocks.push(match[0]);
    }
    return blocks;
  }

  private needsRawRecordEnrichment(csl: CslRisItem, block: string): boolean {
    if (!csl.title || !csl.issued?.['date-parts']?.[0]?.[0]) {
      return true;
    }
    if (csl.page && !String(csl.page).includes('-')) {
      return true;
    }
    // Check if the block contains non-standard/type-specific RIS tags, dates with month/day, or multiline continuations
    return /^(?:ST|ED|A2|PY|Y1|DA|Y2|J2|JA|T2|BT|INST|CY|AD|LA|M1|M3|U1|C3|AN|C2|UR|L1|ET|CN|CA|C1|L4|T3|SE|KW|RN|N1|AB|N2)\s*-/m.test(
      block,
    );
  }

  private extractIdentifiersFromText(
    tag: string,
    val: string,
    isPubMedDb?: boolean,
  ): { pmid?: string; pmcid?: string; arxivId?: string } {
    return extractIdentifiersFromText(tag, val, isPubMedDb);
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
    return buildTypeSpecificFields(params);
  }

  private mapCslTypeToItemType(cslType: string): string {
    return mapCslTypeToZoteroItemType(cslType);
  }

  private mapRisTypeToItemType(risType: string): string {
    return mapRisTypeToItemType(risType);
  }

  fallbackParse(content: string): RisItem[] {
    return RisFallbackParser.parse(content);
  }
}
