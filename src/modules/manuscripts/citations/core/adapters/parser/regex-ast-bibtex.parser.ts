/**
 * citations/core/adapters/parser/regex-ast-bibtex.parser.ts
 * Zero-dependency, pure TypeScript BibTeX parser and serializer.
 * Robust against nested braces, multiline fields, quotes, and comments.
 */

import { IBibtexParserPort } from '../../ports/bibtex-parser.port';
import { BibEntry } from '../../domain/entities/bib-entry.entity';
import { CitationKeyVo } from '../../domain/value-objects/citation-key.vo';

export class RegexAstBibtexParser implements IBibtexParserPort {
  /**
   * Parse a raw BibTeX string into an array of BibEntry entities.
   */
  public parse(rawBibtex: string): BibEntry[] {
    if (!rawBibtex || typeof rawBibtex !== 'string') return [];

    const entries: BibEntry[] = [];
    const cleanSource = this.stripComments(rawBibtex);

    // Regex to locate the start of an entry: @entryType{key,
    const entryStartRegex = /@([a-zA-Z]+)\s*\{\s*([^,\s]+)\s*,/g;

    let match: RegExpExecArray | null;
    while ((match = entryStartRegex.exec(cleanSource)) !== null) {
      const entryType = match[1]!.toLowerCase();
      const rawKey = match[2]!;

      // Skip @comment or @preamble
      if (entryType === 'comment' || entryType === 'preamble' || entryType === 'string') {
        continue;
      }

      // Find the matching closing brace for this entry
      const bodyStartIndex = match.index + match[0].length;
      const bodyEndIndex = this.findMatchingClosingBrace(cleanSource, match.index + match[0].indexOf('{'));

      if (bodyEndIndex === -1) {
        // Unclosed entry: parse as much as possible up to next '@' or EOF
        const nextAt = cleanSource.indexOf('@', bodyStartIndex);
        const bodyContent = nextAt !== -1 ? cleanSource.slice(bodyStartIndex, nextAt) : cleanSource.slice(bodyStartIndex);
        const fields = this.parseFields(bodyContent);
        try {
          entries.push(new BibEntry({ key: rawKey, entryType, fields }));
        } catch {
          // Skip invalid entry
        }
        break;
      }

      const bodyContent = cleanSource.slice(bodyStartIndex, bodyEndIndex);
      const fields = this.parseFields(bodyContent);
      const rawSnippet = cleanSource.slice(match.index, bodyEndIndex + 1);

      try {
        const sanitizedKey = CitationKeyVo.sanitize(rawKey);
        entries.push(
          new BibEntry({
            key: sanitizedKey || rawKey,
            entryType,
            fields,
            rawBibtex: rawSnippet,
          })
        );
      } catch {
        // Skip entry if key is hopelessly invalid
      }

      // Move regex index forward
      entryStartRegex.lastIndex = bodyEndIndex + 1;
    }

    return entries;
  }

  /**
   * Format an array of BibEntry entities into a standardized BibTeX string.
   */
  public format(entries: BibEntry[]): string {
    return entries.map((e) => e.toBibtexString()).join('\n\n');
  }

  /**
   * Extract key-value field pairs from the body of a BibTeX entry.
   */
  private parseFields(body: string): Record<string, string> {
    const fields: Record<string, string> = {};
    let pos = 0;

    while (pos < body.length) {
      // Find field name
      const eqIndex = body.indexOf('=', pos);
      if (eqIndex === -1) break;

      const rawFieldName = body.slice(pos, eqIndex).trim().replace(/^[,;\s]+/, '');
      const fieldName = rawFieldName.toLowerCase();
      pos = eqIndex + 1;

      // Skip whitespace
      while (pos < body.length && /\s/.test(body[pos]!)) {
        pos++;
      }

      if (pos >= body.length) break;

      const firstChar = body[pos];
      let value = '';

      if (firstChar === '{') {
        // Delimited by curly braces: handle nested braces!
        const closeBraceIdx = this.findMatchingClosingBrace(body, pos);
        if (closeBraceIdx !== -1) {
          value = body.slice(pos + 1, closeBraceIdx);
          pos = closeBraceIdx + 1;
        } else {
          value = body.slice(pos + 1);
          pos = body.length;
        }
      } else if (firstChar === '"') {
        // Delimited by double quotes
        let endQuoteIdx = -1;
        for (let j = pos + 1; j < body.length; j++) {
          if (body[j] === '"' && body[j - 1] !== '\\') {
            endQuoteIdx = j;
            break;
          }
        }
        if (endQuoteIdx !== -1) {
          value = body.slice(pos + 1, endQuoteIdx);
          pos = endQuoteIdx + 1;
        } else {
          value = body.slice(pos + 1);
          pos = body.length;
        }
      } else {
        // Naked value (e.g. number 2024 or string macro) up to comma or end of block
        const commaIdx = body.indexOf(',', pos);
        if (commaIdx !== -1) {
          value = body.slice(pos, commaIdx).trim();
          pos = commaIdx + 1;
        } else {
          value = body.slice(pos).trim();
          pos = body.length;
        }
      }

      if (fieldName && fieldName.length > 0 && /^[a-zA-Z0-9_-]+$/.test(fieldName)) {
        // Clean whitespace and linebreaks in values
        fields[fieldName] = value.replace(/\s+/g, ' ').trim();
      }

      // Skip optional comma or trailing spaces
      while (pos < body.length && /[,\s]/.test(body[pos]!)) {
        pos++;
      }
    }

    return fields;
  }

  /**
   * Finds the closing brace corresponding to an opening brace at startIdx.
   */
  private findMatchingClosingBrace(text: string, openBraceIdx: number): number {
    let depth = 0;
    for (let i = openBraceIdx; i < text.length; i++) {
      if (text[i] === '{' && (i === 0 || text[i - 1] !== '\\')) {
        depth++;
      } else if (text[i] === '}' && (i === 0 || text[i - 1] !== '\\')) {
        depth--;
        if (depth === 0) {
          return i;
        }
      }
    }
    return -1;
  }

  /**
   * Strip LaTeX/BibTeX comments (% to end of line).
   */
  private stripComments(text: string): string {
    const lines = text.split('\n');
    const result: string[] = [];

    for (const l of lines) {
      let cleaned = '';
      for (let i = 0; i < l.length; i++) {
        if (l[i] === '%' && (i === 0 || l[i - 1] !== '\\')) {
          break; // comment
        }
        cleaned += l[i];
      }
      result.push(cleaned);
    }

    return result.join('\n');
  }
}
