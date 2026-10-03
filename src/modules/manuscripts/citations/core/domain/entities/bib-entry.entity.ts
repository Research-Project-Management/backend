/**
 * citations/core/domain/entities/bib-entry.entity.ts
 * Aggregate Entity representing an individual BibTeX bibliography entry.
 */

import { CitationKeyVo } from '../value-objects/citation-key.vo';
import { AuthorListVo } from '../value-objects/author-list.vo';
import { toBibtexValue } from '../utils/bibtex-value.utils';

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
  public readonly id: string;
  public readonly key: CitationKeyVo;
  public readonly entryType: string;
  public readonly fields: ReadonlyMap<string, string>;
  public readonly authors: AuthorListVo;
  public readonly title?: string;
  public readonly year?: string;
  public readonly journal?: string;
  public readonly doi?: string;
  public readonly rawBibtex: string;
  public readonly valueFormat: BibValueFormat;

  constructor(props: BibEntryProps) {
    this.id =
      props.id || `entry-${Math.random().toString(36).substring(2, 10)}`;
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

    this.rawBibtex = props.rawBibtex || this.generateBibtex();
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

  public toJSON() {
    const fieldsObj: Record<string, string> = {};
    for (const [k, v] of this.fields.entries()) {
      fieldsObj[k] = v;
    }

    return {
      id: this.id,
      key: this.key.value,
      entryType: this.entryType,
      title: this.title,
      year: this.year,
      journal: this.journal,
      doi: this.doi,
      authorsDisplay: this.authors.toDisplayString(),
      authors: this.authors.toFullNameList(),
      displayLabel: this.getDisplayLabel(),
      fields: fieldsObj,
      rawBibtex: this.rawBibtex,
    };
  }
}
