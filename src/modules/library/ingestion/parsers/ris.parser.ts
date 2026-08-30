import { Injectable } from '@nestjs/common';
import { ItemMetadata } from '../metadata/types/metadata.types';
import { IngestionValidationException } from '../errors/ingestion.errors';

@Injectable()
export class RisParser {
  /**
   * Parses a raw RIS string into one or more ItemMetadata objects.
   */
  parse(content: string): ItemMetadata[] {
    if (!content || typeof content !== 'string' || !content.trim()) {
      throw new IngestionValidationException(
        'RIS content must be a non-empty string',
      );
    }

    const lines = content.split(/\r?\n/);
    const records: ItemMetadata[] = [];
    let currentRecord:
      | (Partial<ItemMetadata> & {
          rawAuthors: string[];
          rawTags: string[];
          startPage?: string;
          endPage?: string;
        })
      | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      // RIS tag pattern: 2 alphanumeric characters, 2 spaces (or optional whitespace), hyphen, space, value
      const match = rawLine.match(/^([A-Z0-9]{2})\s*-\s*(.*)$/);
      if (!match) {
        // Line continuation for multiline fields (e.g. abstract)
        if (currentRecord && line) {
          if (currentRecord.abstract) {
            currentRecord.abstract += ' ' + line;
          }
        }
        continue;
      }

      const [, tag, val] = match;
      const value = val.trim();

      if (tag === 'TY') {
        currentRecord = {
          itemType: this.mapRisType(value),
          rawAuthors: [],
          rawTags: [],
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

      if (!currentRecord) {
        // Started without explicit TY, initialize record
        currentRecord = {
          itemType: 'journalArticle',
          rawAuthors: [],
          rawTags: [],
        };
      }

      switch (tag) {
        case 'TI':
        case 'T1':
        case 'CT':
          if (!currentRecord.title) currentRecord.title = value;
          break;
        case 'AU':
        case 'A1':
        case 'A2':
          if (value) currentRecord.rawAuthors.push(value);
          break;
        case 'JO':
        case 'JF':
        case 'JA':
        case 'T2':
          if (!currentRecord.publicationTitle)
            currentRecord.publicationTitle = value;
          break;
        case 'PY':
        case 'Y1':
        case 'DA': {
          const yearMatch = value.match(/\b(19|20)\d{2}\b/);
          if (yearMatch) currentRecord.year = parseInt(yearMatch[0], 10);
          currentRecord.publicationDate = value;
          break;
        }
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
        case 'UR':
        case 'L1':
          if (!currentRecord.url) currentRecord.url = value;
          break;
        case 'AB':
        case 'N2':
          currentRecord.abstract = currentRecord.abstract
            ? currentRecord.abstract + ' ' + value
            : value;
          break;
        case 'KW':
          if (value) currentRecord.rawTags.push(value);
          break;
        case 'SN':
          if (value.includes('-') || value.length === 8) {
            currentRecord.issn = value;
          } else {
            currentRecord.isbn = value;
          }
          break;
        case 'PB':
          currentRecord.publisher = value;
          break;
      }
    }

    if (currentRecord) {
      records.push(this.finalizeRecord(currentRecord));
    }

    if (records.length === 0) {
      throw new IngestionValidationException(
        'No valid RIS records found in content',
      );
    }

    return records;
  }

  private mapRisType(type: string): string {
    switch (type.toUpperCase()) {
      case 'JOUR':
        return 'journalArticle';
      case 'BOOK':
        return 'book';
      case 'CHAP':
        return 'bookSection';
      case 'CONF':
        return 'conferencePaper';
      case 'THES':
        return 'thesis';
      case 'RPRT':
        return 'report';
      case 'PAT':
        return 'patent';
      case 'ELEC':
      case 'ICOMM':
        return 'webpage';
      default:
        return 'journalArticle';
    }
  }

  private finalizeRecord(
    rec: Partial<ItemMetadata> & {
      rawAuthors: string[];
      rawTags: string[];
      startPage?: string;
      endPage?: string;
    },
  ): ItemMetadata {
    const pages =
      rec.startPage && rec.endPage
        ? `${rec.startPage}-${rec.endPage}`
        : rec.startPage || rec.endPage || undefined;

    const creators = rec.rawAuthors.map((authorName) => {
      const parts = authorName.split(',');
      if (parts.length === 2) {
        return {
          creatorType: 'author',
          lastName: parts[0].trim(),
          firstName: parts[1].trim(),
          name: `${parts[1].trim()} ${parts[0].trim()}`,
        };
      }
      return {
        creatorType: 'author',
        name: authorName.trim(),
      };
    });

    return {
      title: rec.title || 'Untitled Work',
      itemType: rec.itemType || 'journalArticle',
      authors: rec.rawAuthors,
      creators,
      publicationTitle: rec.publicationTitle,
      year: rec.year,
      publicationDate: rec.publicationDate,
      volume: rec.volume,
      issue: rec.issue,
      pages,
      doi: rec.doi,
      url: rec.url,
      abstract: rec.abstract,
      tags: rec.rawTags,
      issn: rec.issn,
      isbn: rec.isbn,
      publisher: rec.publisher,
    };
  }
}
