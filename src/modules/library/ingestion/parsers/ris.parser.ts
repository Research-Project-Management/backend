import { Injectable, Logger } from '@nestjs/common';
import { ItemMetadata, CreatorInput } from '../metadata/types/metadata.types';
import { IngestionValidationException } from '../errors/ingestion.errors';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Cite } = require('@citation-js/core');
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('@citation-js/plugin-ris');

@Injectable()
export class RisParser {
  private readonly logger = new Logger(RisParser.name);

  /**
   * Parses a raw RIS string into one or more ItemMetadata objects using @citation-js engine.
   */
  parse(content: string): ItemMetadata[] {
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

      return data.map((csl: any) => {
        const rawAuthors: string[] = [];
        const creators: CreatorInput[] = [];

        (csl.author || []).forEach((a: any) => {
          const family = a.family?.trim() || '';
          const given = a.given?.trim() || '';
          const fullName =
            a.literal?.trim() ||
            (family && given ? `${family}, ${given}` : family || given);

          if (fullName) {
            rawAuthors.push(fullName);
            creators.push({
              firstName: given || undefined,
              lastName: family || undefined,
              creatorType: 'author',
            });
          }
        });

        // Tags / keywords handling
        const tags: string[] = [];
        if (csl.keyword) {
          if (Array.isArray(csl.keyword)) {
            tags.push(
              ...csl.keyword.map((k: string) => k.trim()).filter(Boolean),
            );
          } else if (typeof csl.keyword === 'string') {
            tags.push(
              ...csl.keyword
                .split(/[,;\n]/)
                .map((k: string) => k.trim())
                .filter(Boolean),
            );
          }
        }

        const year =
          csl.issued?.['date-parts']?.[0]?.[0] != null
            ? Number(csl.issued['date-parts'][0][0])
            : undefined;

        const itemType = this.mapCslTypeToItemType(
          csl.type || 'article-journal',
        );

        // Notes extraction
        const rawNote = csl.note || csl.annote || csl.comment;
        const notes = rawNote
          ? [{ content: String(rawNote).trim(), source: 'ris' }]
          : undefined;

        return {
          itemType,
          title: (csl.title || 'Untitled Reference').trim(),
          authors: rawAuthors,
          creators,
          year,
          publicationDate: year ? String(year) : undefined,
          journal: csl['container-title'] || undefined,
          publicationTitle: csl['container-title'] || undefined,
          publisher: csl.publisher || undefined,
          volume: csl.volume ? String(csl.volume) : undefined,
          issue: csl.issue ? String(csl.issue) : undefined,
          pages: csl.page ? String(csl.page) : undefined,
          doi: csl.DOI || undefined,
          url: csl.URL || undefined,
          abstract: csl.abstract || undefined,
          tags,
          keywords: tags,
          notes,
        };
      });
    } catch (err: any) {
      this.logger.warn(
        `Citation.js RIS parser error: ${err?.message || err}. Falling back to manual line parser.`,
      );
      return this.fallbackParse(content);
    }
  }

  private mapCslTypeToItemType(cslType: string): string {
    const map: Record<string, string> = {
      'article-journal': 'journalArticle',
      'paper-conference': 'conferencePaper',
      book: 'book',
      chapter: 'bookSection',
      thesis: 'thesis',
      report: 'report',
      webpage: 'webpage',
      patent: 'patent',
      dataset: 'dataset',
      software: 'computerProgram',
    };
    return map[cslType] || 'journalArticle';
  }

  /**
   * Resilient line-by-line parser for non-standard RIS dialect variations
   */
  private fallbackParse(content: string): ItemMetadata[] {
    const lines = content.split(/\r?\n/);
    const records: ItemMetadata[] = [];
    let currentRecord:
      | (Partial<ItemMetadata> & {
          rawAuthors: string[];
          rawTags: string[];
          rawNotes?: string[];
          startPage?: string;
          endPage?: string;
        })
      | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      const match = rawLine.match(/^([A-Z0-9]{2})\s*-\s*(.*)$/);
      if (!match) {
        if (currentRecord && line && currentRecord.abstract) {
          currentRecord.abstract += ' ' + line;
        }
        continue;
      }

      const [, tag, val] = match;
      const value = val.trim();

      if (tag === 'TY') {
        currentRecord = {
          itemType: 'journalArticle',
          rawAuthors: [],
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
        case 'AU':
        case 'A1':
          currentRecord.rawAuthors.push(value);
          break;
        case 'PY':
        case 'Y1':
          const yearMatch = value.match(/\b(19|20)\d{2}\b/);
          if (yearMatch) currentRecord.year = parseInt(yearMatch[0], 10);
          break;
        case 'JO':
        case 'JF':
        case 'T2':
          currentRecord.publicationTitle = value;
          currentRecord.journal = value;
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
        case 'KW':
          currentRecord.rawTags.push(value);
          break;
        case 'N1':
          if (!currentRecord.rawNotes) currentRecord.rawNotes = [];
          currentRecord.rawNotes.push(value);
          break;
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
    record: Partial<ItemMetadata> & {
      rawAuthors: string[];
      rawTags: string[];
      rawNotes?: string[];
      startPage?: string;
      endPage?: string;
    },
  ): ItemMetadata {
    const creators: CreatorInput[] = record.rawAuthors.map((authorStr) => {
      const parts = authorStr.split(',').map((p) => p.trim());
      if (parts.length >= 2) {
        return {
          lastName: parts[0],
          firstName: parts.slice(1).join(' '),
          creatorType: 'author',
        };
      }
      return {
        lastName: authorStr,
        creatorType: 'author',
      };
    });

    let pages = record.pages;
    if (!pages && record.startPage) {
      pages = record.endPage
        ? `${record.startPage}-${record.endPage}`
        : record.startPage;
    }

    return {
      itemType: record.itemType || 'journalArticle',
      title: record.title || 'Untitled Reference',
      authors: record.rawAuthors,
      creators,
      year: record.year,
      journal: record.journal,
      publicationTitle: record.publicationTitle,
      volume: record.volume,
      issue: record.issue,
      pages,
      doi: record.doi,
      tags: record.rawTags,
      keywords: record.rawTags,
      abstract: record.abstract,
      notes:
        record.rawNotes && record.rawNotes.length > 0
          ? record.rawNotes.map((n) => ({ content: n, source: 'ris' }))
          : undefined,
    };
  }
}
