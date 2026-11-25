/**
 * citations/domain/entities/bib-entry.entity.ts
 * Aggregate Entity representing an individual BibTeX bibliography entry.
 */

import { randomUUID } from 'crypto';
import { CitationKeyVo, AuthorListVo } from './value-objects.domain';
import {
  toBibtexValue,
  formatBibtexName,
  sanitizeCitationKey,
} from './bibtex.domain';
import { InvalidBibtexException } from './citations.errors';
import type { StructuredCitationEntryInput } from '../types/citations.types';

/**
 * How field values should be treated when serializing:
 * - 'latex' (default): values are already valid BibTeX/LaTeX (e.g. parsed from a .bib file)
 *   and are emitted verbatim to avoid double escaping.
 * - 'plain': values are plain text from external metadata (CrossRef/arXiv/DB) and are
 *   escaped + case-protected via toBibtexValue().
 */
export type BibValueFormat = 'latex' | 'plain';

export interface BibEntryProps {
  id?: string;
  key: string | CitationKeyVo;
  entryType: string;
  fields: Record<string, string>;
  rawBibtex?: string;
  valueFormat?: BibValueFormat;
}

export class BibEntry {
  private _id?: string;
  private _rawBibtex?: string;
  public readonly key: CitationKeyVo;
  public readonly entryType: string;
  public readonly fields: ReadonlyMap<string, string>;
  public readonly authors: AuthorListVo;
  public readonly title?: string;
  public readonly year?: string;
  public readonly journal?: string;
  public readonly doi?: string;
  public readonly valueFormat: BibValueFormat;

  constructor(props: BibEntryProps) {
    this._id = props.id;
    this.key =
      props.key instanceof CitationKeyVo
        ? props.key
        : CitationKeyVo.create(props.key);
    this.entryType = props.entryType.trim().toLowerCase();
    this.valueFormat = props.valueFormat ?? 'latex';

    const normalizedFields = new Map<string, string>();
    for (const [k, v] of Object.entries(props.fields)) {
      normalizedFields.set(k.trim().toLowerCase(), v.trim());
    }
    this.fields = normalizedFields;

    const authorStr =
      this.fields.get('author') || this.fields.get('authors') || '';
    this.authors = new AuthorListVo(authorStr);

    this.title = this.cleanField(this.fields.get('title'));
    this.year = this.cleanField(this.fields.get('year'));
    this.journal = this.cleanField(
      this.fields.get('journal') ||
        this.fields.get('booktitle') ||
        this.fields.get('publisher'),
    );
    this.doi = this.cleanField(this.fields.get('doi'));

    this._rawBibtex = props.rawBibtex;
  }

  public get id(): string {
    if (!this._id) {
      this._id = `entry-${randomUUID()}`;
    }
    return this._id;
  }

  public get rawBibtex(): string {
    if (!this._rawBibtex) {
      this._rawBibtex = this.generateBibtex();
    }
    return this._rawBibtex;
  }

  public getFieldValue(fieldName: string): string | undefined {
    return this.fields.get(fieldName.toLowerCase());
  }

  /**
   * Generates a clean human-readable label for autocompletion dropdowns.
   * Format: "Vaswani et al. (2017) - Attention is all you need"
   */
  public getDisplayLabel(): string {
    const authorPart = this.authors.toDisplayString();
    const yearPart = this.year ? ` (${this.year})` : '';
    const titlePart = this.title ? ` - ${this.title}` : '';
    return `${authorPart}${yearPart}${titlePart}`;
  }

  public toBibtexString(): string {
    return this.generateBibtex();
  }

  private generateBibtex(): string {
    const lines = [`@${this.entryType}{${this.key.value},`];
    for (const [k, v] of this.fields.entries()) {
      const value =
        this.valueFormat === 'plain' ? toBibtexValue(v, { field: k }) : v;
      if (!value) continue;
      lines.push(`  ${k} = {${value}},`);
    }
    lines.push('}');
    return lines.join('\n');
  }

  private cleanField(val?: string): string | undefined {
    if (!val) return undefined;
    return val
      .replace(/^\{+|\}+$/g, '')
      .replace(/^"+|"+$/g, '')
      .trim();
  }

  public toJSON(sourceFile = 'references.bib') {
    const journal = this.cleanField(this.fields.get('journal'));
    const booktitle = this.cleanField(this.fields.get('booktitle'));
    const publisher = this.cleanField(this.fields.get('publisher'));
    const volume = this.cleanField(this.fields.get('volume'));
    const number = this.cleanField(this.fields.get('number'));
    const pages = this.cleanField(this.fields.get('pages'));
    const url = this.cleanField(this.fields.get('url'));
    const abstract = this.cleanField(this.fields.get('abstract'));

    return {
      key: this.key.value,
      sourceFile,
      type: this.entryType,
      title: this.title ?? '',
      authors: this.authors.toFullNameList(),
      ...(this.year ? { year: this.year } : {}),
      ...(journal ? { journal } : {}),
      ...(booktitle ? { booktitle } : {}),
      ...(publisher ? { publisher } : {}),
      ...(volume ? { volume } : {}),
      ...(number ? { number } : {}),
      ...(pages ? { pages } : {}),
      ...(this.doi ? { doi: this.doi } : {}),
      ...(url ? { url } : {}),
      ...(abstract ? { abstract } : {}),
    };
  }
}


/**
 * citations/domain/entities/bibliography-file.entity.ts
 * Entity modeling an entire parsed .bib file inside the manuscript project.
 */

// ─── BibliographyFile Entity ──────────────────────────────────────────────────

export interface BibliographyFileProps {
  path: string;
  entries: BibEntry[];
}

export class BibliographyFile {
  public readonly path: string;
  public readonly entries: readonly BibEntry[];
  public readonly duplicateKeys: readonly string[];
  public readonly totalCount: number;

  constructor(props: BibliographyFileProps) {
    this.path = props.path;
    this.entries = Object.freeze([...props.entries]);
    this.totalCount = this.entries.length;

    // Detect duplicate keys within this file
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const e of this.entries) {
      const k = e.key.value.toLowerCase();
      if (seen.has(k)) {
        dupes.add(e.key.value);
      } else {
        seen.add(k);
      }
    }
    this.duplicateKeys = Object.freeze([...dupes]);
  }

  public getEntryByKey(key: string): BibEntry | undefined {
    const norm = key.trim().toLowerCase();
    return this.entries.find((e) => e.key.value.toLowerCase() === norm);
  }

  public findMatches(query?: string): BibEntry[] {
    if (!query || query.trim() === '') {
      return [...this.entries];
    }

    const q = query.trim().toLowerCase();
    return this.entries.filter((e) => {
      if (e.key.value.toLowerCase().includes(q)) return true;
      if (e.title && e.title.toLowerCase().includes(q)) return true;
      if (e.year && e.year.includes(q)) return true;
      if (e.authors.toDisplayString().toLowerCase().includes(q)) return true;
      if (e.authors.toFullNameList().some((fn) => fn.toLowerCase().includes(q)))
        return true;
      return false;
    });
  }

  public toJSON() {
    return {
      path: this.path,
      totalCount: this.totalCount,
      duplicateKeys: [...this.duplicateKeys],
      entries: this.entries.map((e) => e.toJSON()),
    };
  }
}


/**
 * citations/domain/citation-operations.ts
 * Converts structured citation/library payloads into normalized domain `BibEntry` entities.
 */

// ─── BibliographyFile Entity ──────────────────────────────────────────────────
// ─── Structured Input Mapper ──────────────────────────────────────────────────

export type { StructuredCitationEntryInput };

/**
 * Converts a structured item or BibEntry payload into a domain `BibEntry`.
 */
export function buildBibEntryFromInput(
  input: StructuredCitationEntryInput,
): BibEntry {
  const rawKey =
    input.key ||
    input.citationKey ||
    input.id ||
    (input.title
      ? sanitizeCitationKey(input.title.split(/\s+/)[0] || 'ref')
      : 'reference');
  const cleanKey = sanitizeCitationKey(String(rawKey)) || 'reference';

  const rawType = (input.entryType || input.type || input.itemType || 'article')
    .toString()
    .toLowerCase();
  let entryType = 'article';
  if (rawType.includes('book') && !rawType.includes('inbook')) {
    entryType = 'book';
  } else if (
    rawType.includes('conf') ||
    rawType.includes('proc') ||
    rawType === 'inproceedings'
  ) {
    entryType = 'inproceedings';
  } else if (rawType.includes('thesis')) {
    entryType = 'phdthesis';
  } else if (/^[a-z]+$/.test(rawType)) {
    entryType = rawType;
  }

  const fields: Record<string, string> = { ...(input.fields || {}) };

  if (input.title && !fields.title) {
    fields.title = String(input.title);
  }

  if (!fields.author) {
    if (Array.isArray(input.authors) && input.authors.length > 0) {
      fields.author = input.authors.filter(Boolean).join(' and ');
    } else if (typeof input.author === 'string' && input.author.trim()) {
      fields.author = input.author.trim();
    } else if (
      Array.isArray(input.contributors) &&
      input.contributors.length > 0
    ) {
      const names = input.contributors
        .map((c) => {
          if (c.literal) return `{${c.literal}}`;
          if (c.name || c.fullName) return (c.name || c.fullName || '').trim();
          return formatBibtexName({
            lastName: c.lastName,
            firstName: c.firstName,
            fieldMode: c.fieldMode,
          });
        })
        .filter(Boolean);
      if (names.length > 0) {
        fields.author = names.join(' and ');
      }
    }
  }

  const journalVal = input.journal || input.publicationTitle;
  if (journalVal && !fields.journal && !fields.booktitle) {
    if (entryType === 'inproceedings') {
      fields.booktitle = String(journalVal);
    } else {
      fields.journal = String(journalVal);
    }
  }
  if (input.booktitle && !fields.booktitle) {
    fields.booktitle = String(input.booktitle);
  }
  if (input.publisher && !fields.publisher) {
    fields.publisher = String(input.publisher);
  }

  const yearVal =
    input.year ??
    (typeof input.date === 'string' && input.date.length >= 4
      ? input.date.slice(0, 4)
      : undefined);
  if (
    yearVal !== undefined &&
    yearVal !== null &&
    String(yearVal).trim() &&
    !fields.year
  ) {
    fields.year = String(yearVal).trim();
  }

  if (input.volume && !fields.volume) fields.volume = String(input.volume);
  if ((input.number || input.issue) && !fields.number) {
    fields.number = String(input.number || input.issue);
  }
  if (input.pages && !fields.pages) fields.pages = String(input.pages);
  if (input.doi && !fields.doi) fields.doi = String(input.doi);
  if (input.url && !fields.url) fields.url = String(input.url);

  const abstractVal = input.abstract || input.abstractNote;
  if (abstractVal && !fields.abstract) {
    fields.abstract = String(abstractVal).replace(/\s+/g, ' ').trim();
  }

  const rawBib = (input.rawBibtex || input.raw || '').trim();
  if (!cleanKey) {
    throw new InvalidBibtexException('Citation key cannot be empty');
  }

  return new BibEntry({
    id: input.id,
    key: cleanKey,
    entryType,
    fields,
    rawBibtex: rawBib.startsWith('@') ? rawBib : undefined,
    valueFormat: rawBib.startsWith('@') ? 'latex' : 'plain',
  });
}

