/**
 * citations/core/domain/entities/bibliography-file.entity.ts
 * Entity modeling an entire parsed .bib file inside the manuscript project.
 */

import { BibEntry } from './bib-entry.entity';

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
      if (e.authors.toFullNameList().some((fn) => fn.toLowerCase().includes(q))) return true;
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
