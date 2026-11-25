import { BibEntry } from './bib-entry.domain';
import { formatBibtexName, sanitizeCitationKey } from './bibtex-formatter.domain';
import { InvalidBibtexException } from './citations.errors';
import type { StructuredCitationEntryInput } from '../types/citations.types';

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

