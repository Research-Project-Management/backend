/**
 * citations/domain/citation-operations.ts
 * Domain logic for project-wide citation key refactoring, bibliography generation/injection,
 * and structured item-to-BibEntry conversion.
 */

import { BibEntry } from './bib-entry.entity';
import { formatBibtexName, sanitizeCitationKey } from './bibtex.formatter';
import { InvalidBibtexException } from './citations.errors';

export interface ValidateCitationKeyResult {
  isValid: boolean;
  error?: string;
}

export interface RefactorFileResult {
  content: string;
  count: number;
}

export interface BuildBibliographyOptions {
  bibliographyText?: string;
  format?: 'markdown' | 'latex';
  styleId?: string;
  headingTitle?: string;
  citations?: Array<{
    key?: string;
    inText?: string;
    bibliography?: string;
  }>;
}

export interface InjectBibliographyResult {
  nextContent: string;
  action: 'replaced' | 'appended';
  section: string;
  format: 'markdown' | 'latex';
}

export interface StructuredCitationEntryInput {
  id?: string;
  key?: string;
  citationKey?: string;
  entryType?: string;
  type?: string;
  itemType?: string;
  title?: string;
  author?: string;
  authors?: string[];
  contributors?: Array<{
    name?: string | null;
    fullName?: string | null;
    lastName?: string | null;
    firstName?: string | null;
    literal?: string | null;
    fieldMode?: number | null;
  }>;
  year?: string | number;
  date?: string;
  journal?: string;
  publicationTitle?: string;
  booktitle?: string;
  publisher?: string;
  volume?: string;
  number?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  abstractNote?: string;
  raw?: string;
  rawBibtex?: string;
  fields?: Record<string, string>;
}

const PANDOC_BRACKET_REGEX = /\[([^\]]*@[a-zA-Z0-9_:-]+[^\]]*)\]/g;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validates a citation key according to BibTeX / BibLaTeX / Natbib standards.
 */
export function validateCitationKey(
  key: string,
  oldKey?: string,
): ValidateCitationKeyResult {
  const trimmed = (key || '').trim();

  if (!trimmed) {
    return { isValid: false, error: 'Citation key cannot be empty.' };
  }

  if (trimmed.startsWith('@')) {
    return {
      isValid: false,
      error: 'Citation key should not start with @ (it is detected automatically).',
    };
  }

  if (/\s/.test(trimmed)) {
    return { isValid: false, error: 'Citation key cannot contain whitespace.' };
  }

  if (/[\\{},~"%\$\^]/.test(trimmed)) {
    return {
      isValid: false,
      error: 'Citation key cannot contain special characters ({ }, \\, ~, ", %, $, ^).',
    };
  }

  if (oldKey && trimmed.toLowerCase() === oldKey.trim().toLowerCase()) {
    return {
      isValid: false,
      error: 'New citation key must be different from the current key.',
    };
  }

  const validPattern = /^[a-zA-Z0-9_:.#/-]+$/;
  if (!validPattern.test(trimmed)) {
    return {
      isValid: false,
      error: 'Citation key may only contain letters, numbers, and: _ : - . # /',
    };
  }

  return { isValid: true };
}

/**
 * Refactors a citation key inside BibTeX bibliography source text.
 * Replaces `@type{oldKey,` and `key = {oldKey}` while preserving all inner formatting.
 */
export function refactorCitationKeyInBibTeX(
  bibContent: string,
  oldKey: string,
  newKey: string,
): RefactorFileResult {
  if (!bibContent || !oldKey || !newKey || oldKey === newKey) {
    return { content: bibContent, count: 0 };
  }

  let count = 0;
  const escapedOld = escapeRegex(oldKey);

  const entryDefRegex = new RegExp(
    `(@[a-zA-Z0-9_-]+\\s*[{()]\\s*)(${escapedOld})(\\s*,)`,
    'gi',
  );

  let updated = bibContent.replace(
    entryDefRegex,
    (_match, prefix: string, _key: string, suffix: string) => {
      count++;
      return `${prefix}${newKey}${suffix}`;
    },
  );

  const keyFieldRegex = new RegExp(
    `(\\bkey\\s*=\\s*[{"]\\s*)(${escapedOld})(\\s*[}"]\\s*,?)`,
    'gi',
  );

  updated = updated.replace(
    keyFieldRegex,
    (_match, prefix: string, _key: string, suffix: string) => {
      count++;
      return `${prefix}${newKey}${suffix}`;
    },
  );

  return { content: updated, count };
}

/**
 * Refactors citation keys in LaTeX / Pandoc Markdown source text.
 * Strictly matches command arguments (\cite*, \bibitem) and boundary-delimited Pandoc citations.
 */
export function refactorCitationKeyInLatex(
  text: string,
  oldKey: string,
  newKey: string,
): RefactorFileResult {
  if (!text || !oldKey || !newKey || oldKey === newKey) {
    return { content: text, count: 0 };
  }

  let count = 0;
  const targetLower = oldKey.toLowerCase();

  // 1. LaTeX citation commands (\cite, \citep, \citet, \autocite, \nocite, etc.)
  const LATEX_CITE_REPLACE_REGEX =
    /(\\(?:auto|paren|text|foot|no|new|short)?cite(?:p|t|alt|alp|author|year|date|num|a)?\*?(?:\[[^\]]*\])*(?:\[[^\]]*\])*\{)([^}]+)(\})/gi;

  let updated = text.replace(
    LATEX_CITE_REPLACE_REGEX,
    (_fullMatch, prefix: string, innerKeys: string, suffix: string) => {
      const parts = innerKeys.split(',');
      let modified = false;

      const newParts = parts.map((part: string) => {
        const trimmed = part.trim();
        if (trimmed.toLowerCase() === targetLower) {
          count++;
          modified = true;
          const leadingSpace = part.slice(0, part.indexOf(trimmed));
          const trailingSpace = part.slice(
            part.indexOf(trimmed) + trimmed.length,
          );
          return `${leadingSpace}${newKey}${trailingSpace}`;
        }
        return part;
      });

      if (modified) {
        return `${prefix}${newParts.join(',')}${suffix}`;
      }
      return _fullMatch;
    },
  );

  // 1b. \bibitem[...]{oldKey} in inline LaTeX bibliography environments
  const BIBITEM_REPLACE_REGEX = new RegExp(
    `(\\\\bibitem(?:\\[[^\\]]*\\])?\\{\\s*)(${escapeRegex(oldKey)})(\\s*\\})`,
    'gi',
  );
  updated = updated.replace(
    BIBITEM_REPLACE_REGEX,
    (_m, prefix: string, _key: string, suffix: string) => {
      count++;
      return `${prefix}${newKey}${suffix}`;
    },
  );

  // 2. Pandoc bracketed citations: [@key1; @key2, p. 20]
  updated = updated.replace(
    PANDOC_BRACKET_REGEX,
    (fullBracket: string, inner: string) => {
      const atRegex = new RegExp(
        `(@)(${escapeRegex(oldKey)})(?=[\\s,;\\]]|$)`,
        'gi',
      );
      let bracketModified = false;
      const newInner = inner.replace(
        atRegex,
        (_m: string, atPrefix: string) => {
          count++;
          bracketModified = true;
          return `${atPrefix}${newKey}`;
        },
      );

      return bracketModified ? `[${newInner}]` : fullBracket;
    },
  );

  // 3. Inline Pandoc citations: @oldKey in prose
  const INLINE_CITE_REGEX = new RegExp(
    `(^|[\\s(])(@)(${escapeRegex(oldKey)})(?=[\\s.,;:?!)\\]]|$)`,
    'gi',
  );
  updated = updated.replace(
    INLINE_CITE_REGEX,
    (_m, before: string, atPrefix: string) => {
      count++;
      return `${before}${atPrefix}${newKey}`;
    },
  );

  return { content: updated, count };
}

/**
 * Detects whether a document is LaTeX or Markdown based on file extension and syntax markers.
 */
export function isLatexDocument(content: string, filePath?: string): boolean {
  if (filePath) {
    const lowerPath = filePath.toLowerCase();
    if (lowerPath.endsWith('.tex') || lowerPath.endsWith('.latex')) {
      return true;
    }
    if (
      lowerPath.endsWith('.md') ||
      lowerPath.endsWith('.markdown') ||
      lowerPath.endsWith('.qmd')
    ) {
      return false;
    }
  }

  if (!content) return false;

  const latexMarkers = [
    /\\documentclass/i,
    /\\begin\{document\}/i,
    /\\section\*?\{/i,
    /\\usepackage/i,
    /\\begin\{thebibliography\}/i,
  ];

  return latexMarkers.some((regex) => regex.test(content));
}

/**
 * Builds a clean, publication-ready Bibliography section for Markdown or LaTeX (\bibitem).
 */
export function buildBibliographySection({
  bibliographyText = '',
  format = 'latex',
  styleId = 'auto',
  headingTitle,
  citations = [],
}: BuildBibliographyOptions): string {
  const isNumeric = [
    'ieee',
    'vancouver',
    'nature',
    'numeric',
    'auto-numeric',
    'tcvn-numeric',
  ].some((s) => styleId.toLowerCase().includes(s));

  const cleanBibText = (bibliographyText || '').trim();
  const isVn =
    Boolean(styleId && styleId.toLowerCase().includes('tcvn')) ||
    /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđĐ]/.test(
      cleanBibText,
    ) ||
    citations.some((c) =>
      /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđĐ]/.test(
        c.bibliography || '',
      ),
    );
  const title = headingTitle || (isVn ? 'Tài liệu tham khảo' : 'References');

  if (format === 'latex') {
    if (citations && citations.length > 0) {
      const bibitems = citations
        .map((c, index) => {
          const key = c.key || `ref_${index + 1}`;
          const text = (c.bibliography || '').trim();
          return `\\bibitem{${key}}\n${text}`;
        })
        .join('\n\n');

      return `\\begin{thebibliography}{99}\n\n${bibitems}\n\n\\end{thebibliography}`;
    }

    const lines = cleanBibText
      .split(/\n\s*\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const bibitems = lines
      .map((line, index) => `\\bibitem{ref_${index + 1}}\n${line}`)
      .join('\n\n');

    return `\\begin{thebibliography}{99}\n\n${bibitems}\n\n\\end{thebibliography}`;
  }

  let rawEntries: string[] = [];
  if (citations && citations.length > 0) {
    rawEntries = citations
      .map((c) => (c.bibliography || '').trim())
      .filter(Boolean);
  } else {
    rawEntries = cleanBibText
      .split(/\n+/)
      .map((e) => e.trim())
      .filter(Boolean);
  }

  const formattedEntries = isNumeric
    ? rawEntries
        .map((entry, idx) =>
          /^\[\d+\]/.test(entry) ? entry : `[${idx + 1}] ${entry}`,
        )
        .join('\n\n')
    : rawEntries
        .map((entry, idx) =>
          /^\d+\.\s*/.test(entry) ? entry : `${idx + 1}. ${entry}`,
        )
        .join('\n\n');

  return `## ${title}\n\n${formattedEntries}`;
}

/**
 * Injects or updates a bibliography section inside document content without duplication.
 */
export function injectBibliographyIntoDocument({
  currentContent,
  newSection,
  format,
}: {
  currentContent: string;
  newSection: string;
  format: 'markdown' | 'latex';
}): InjectBibliographyResult {
  const content = currentContent || '';
  const trimmedSection = newSection.trim();

  if (format === 'latex') {
    const bibRegex =
      /\\begin\{thebibliography\}[\s\S]*?\\end\{thebibliography\}/i;
    if (bibRegex.test(content)) {
      return {
        nextContent: content.replace(bibRegex, trimmedSection),
        action: 'replaced',
        section: trimmedSection,
        format,
      };
    }

    const endDocRegex = /\\end\{document\}/i;
    if (endDocRegex.test(content)) {
      return {
        nextContent: content.replace(
          endDocRegex,
          `${trimmedSection}\n\n\\end{document}`,
        ),
        action: 'appended',
        section: trimmedSection,
        format,
      };
    }

    const separator = content.endsWith('\n\n')
      ? ''
      : content.endsWith('\n')
        ? '\n'
        : '\n\n';
    return {
      nextContent: `${content}${separator}${trimmedSection}\n`,
      action: 'appended',
      section: trimmedSection,
      format,
    };
  }

  const mdBibRegex =
    /(?:^|\n)(#{1,3}\s*(?:Tài liệu tham khảo|TÀI LIỆU THAM KHẢO|References|REFERENCES|Bibliography|BIBLIOGRAPHY)[\s\S]*?$)/i;

  if (mdBibRegex.test(content)) {
    return {
      nextContent: content.replace(mdBibRegex, `\n\n${trimmedSection}\n`),
      action: 'replaced',
      section: trimmedSection,
      format,
    };
  }

  const separator = content.endsWith('\n\n')
    ? ''
    : content.endsWith('\n')
      ? '\n'
      : '\n\n';
  return {
    nextContent: `${content.trimEnd()}${separator}${trimmedSection}\n`,
    action: 'appended',
    section: trimmedSection,
    format,
  };
}

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

  const rawType = (
    input.entryType ||
    input.type ||
    input.itemType ||
    'article'
  )
    .toString()
    .toLowerCase();
  let entryType = 'article';
  if (rawType.includes('book') && !rawType.includes('inbook')) {
    entryType = 'book';
  } else if (rawType.includes('conf') || rawType.includes('proc') || rawType === 'inproceedings') {
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
    } else if (Array.isArray(input.contributors) && input.contributors.length > 0) {
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
  if (yearVal !== undefined && yearVal !== null && String(yearVal).trim() && !fields.year) {
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
