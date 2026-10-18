/**
 * citations/domain/regex-ast-bibtex.parser.ts
 * Zero-dependency, pure TypeScript BibTeX parser and serializer.
 * Robust against nested braces, multiline fields, quotes, and comments.
 */

import { IBibtexParserPort } from './citations.ports';
import { BibEntry } from './entities/bib-entry.entity';
import { CitationKeyVo } from './value-objects/citation-key.vo';

export class RegexAstBibtexParser implements IBibtexParserPort {
  private static readonly STANDARD_MONTH_MACROS: Record<string, string> = {
    jan: 'January',
    feb: 'February',
    mar: 'March',
    apr: 'April',
    may: 'May',
    jun: 'June',
    jul: 'July',
    aug: 'August',
    sep: 'September',
    oct: 'October',
    nov: 'November',
    dec: 'December',
  };

  /**
   * Parse a raw BibTeX string into an array of BibEntry entities.
   */
  public parse(rawBibtex: string): BibEntry[] {
    if (!rawBibtex || typeof rawBibtex !== 'string') return [];

    const entries: BibEntry[] = [];
    const cleanSource = this.stripComments(rawBibtex);
    const stringMacros: Record<string, string> = {
      ...RegexAstBibtexParser.STANDARD_MONTH_MACROS,
    };

    // 1. Pre-scan @string{key = value} or @string(key = value) macro definitions
    const stringDefRegex = /@string\s*([{(])/gi;
    let strMatch: RegExpExecArray | null;
    while ((strMatch = stringDefRegex.exec(cleanSource)) !== null) {
      const openChar = strMatch[1];
      const openIdx = strMatch.index + strMatch[0].length - 1;
      const closeIdx =
        openChar === '('
          ? this.findMatchingClosingParen(cleanSource, openIdx)
          : this.findMatchingClosingBrace(cleanSource, openIdx);
      if (closeIdx !== -1) {
        const body = cleanSource.slice(openIdx + 1, closeIdx);
        const parsedMacro = this.parseFields(body, stringMacros);
        for (const [k, v] of Object.entries(parsedMacro)) {
          stringMacros[k.toLowerCase()] = v;
        }
        stringDefRegex.lastIndex = closeIdx + 1;
      }
    }

    // 2. Locate the start of each entry: @entryType{key, or @entryType(key,
    const entryStartRegex = /@([a-zA-Z]+)\s*([{(])\s*([^,\s}()]+)\s*,/g;

    let match: RegExpExecArray | null;
    while ((match = entryStartRegex.exec(cleanSource)) !== null) {
      const entryType = match[1].toLowerCase();
      const openDelim = match[2];
      const rawKey = match[3];

      // Skip @comment, @preamble, or @string
      if (
        entryType === 'comment' ||
        entryType === 'preamble' ||
        entryType === 'string'
      ) {
        continue;
      }

      const openDelimIndex = match.index + match[0].indexOf(openDelim);
      const bodyStartIndex = match.index + match[0].length;
      const bodyEndIndex =
        openDelim === '('
          ? this.findMatchingClosingParen(cleanSource, openDelimIndex)
          : this.findMatchingClosingBrace(cleanSource, openDelimIndex);

      if (bodyEndIndex === -1) {
        // Unclosed entry: parse as much as possible up to next '@' or EOF
        const nextAt = cleanSource.indexOf('@', bodyStartIndex);
        const bodyContent =
          nextAt !== -1
            ? cleanSource.slice(bodyStartIndex, nextAt)
            : cleanSource.slice(bodyStartIndex);
        const fields = this.parseFields(bodyContent, stringMacros);
        try {
          entries.push(new BibEntry({ key: rawKey, entryType, fields }));
        } catch {
          // Skip invalid entry
        }
        break;
      }

      const bodyContent = cleanSource.slice(bodyStartIndex, bodyEndIndex);
      const fields = this.parseFields(bodyContent, stringMacros);
      const rawSnippet = cleanSource.slice(match.index, bodyEndIndex + 1);

      try {
        const sanitizedKey = CitationKeyVo.sanitize(rawKey);
        entries.push(
          new BibEntry({
            key: sanitizedKey || rawKey,
            entryType,
            fields,
            rawBibtex: rawSnippet,
          }),
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
   * Extract key-value field pairs from the body of a BibTeX entry,
   * supporting # string concatenation and @string macro expansion.
   */
  private parseFields(
    body: string,
    stringMacros: Record<string, string> = {},
  ): Record<string, string> {
    const fields: Record<string, string> = {};
    let pos = 0;

    while (pos < body.length) {
      // Find field name
      const eqIndex = body.indexOf('=', pos);
      if (eqIndex === -1) break;

      const rawFieldName = body
        .slice(pos, eqIndex)
        .trim()
        .replace(/^[,;\s]+/, '');
      const fieldName = rawFieldName.toLowerCase();
      pos = eqIndex + 1;

      const parts: string[] = [];

      // Read one or more value segments joined by '#'
      while (pos < body.length) {
        while (pos < body.length && /\s/.test(body[pos])) {
          pos++;
        }
        if (pos >= body.length) break;

        const firstChar = body[pos];
        let segmentValue = '';

        if (firstChar === '{') {
          // Delimited by curly braces: handle nested braces!
          const closeBraceIdx = this.findMatchingClosingBrace(body, pos);
          if (closeBraceIdx !== -1) {
            segmentValue = body.slice(pos + 1, closeBraceIdx);
            pos = closeBraceIdx + 1;
          } else {
            segmentValue = body.slice(pos + 1);
            pos = body.length;
          }
        } else if (firstChar === '"') {
          // Delimited by double quotes (respecting nested braces or escaped quotes)
          let endQuoteIdx = -1;
          let braceDepth = 0;
          for (let j = pos + 1; j < body.length; j++) {
            if (body[j] === '{' && body[j - 1] !== '\\') braceDepth++;
            else if (body[j] === '}' && body[j - 1] !== '\\')
              braceDepth = Math.max(0, braceDepth - 1);
            else if (
              body[j] === '"' &&
              body[j - 1] !== '\\' &&
              braceDepth === 0
            ) {
              endQuoteIdx = j;
              break;
            }
          }
          if (endQuoteIdx !== -1) {
            segmentValue = body.slice(pos + 1, endQuoteIdx);
            pos = endQuoteIdx + 1;
          } else {
            segmentValue = body.slice(pos + 1);
            pos = body.length;
          }
        } else {
          // Naked value (e.g. number 2024 or @string macro identifier) up to '#', ',', or end of block
          let tokenEnd = pos;
          while (
            tokenEnd < body.length &&
            body[tokenEnd] !== ',' &&
            body[tokenEnd] !== '#'
          ) {
            tokenEnd++;
          }
          const rawToken = body.slice(pos, tokenEnd).trim();
          const macroLookup = stringMacros[rawToken.toLowerCase()];
          segmentValue = macroLookup !== undefined ? macroLookup : rawToken;
          pos = tokenEnd;
        }

        parts.push(segmentValue);

        // Skip whitespace and check if '#' concatenation follows
        while (pos < body.length && /\s/.test(body[pos])) {
          pos++;
        }
        if (pos < body.length && body[pos] === '#') {
          pos++; // consume '#' and loop to read next concatenated segment
        } else {
          break;
        }
      }

      const value = parts.join('');

      if (
        fieldName &&
        fieldName.length > 0 &&
        /^[a-zA-Z0-9_.:-]+$/.test(fieldName)
      ) {
        // Clean whitespace and linebreaks in values
        fields[fieldName] = value.replace(/\s+/g, ' ').trim();
      }

      // Skip optional comma or trailing spaces
      while (pos < body.length && /[,\s]/.test(body[pos])) {
        pos++;
      }
    }

    return fields;
  }

  /**
   * Finds the closing brace corresponding to an opening brace at openBraceIdx.
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
   * Finds the closing parenthesis corresponding to an opening parenthesis at openParenIdx
   * (for @article(...) or @string(...) entries).
   */
  private findMatchingClosingParen(text: string, openParenIdx: number): number {
    let parenDepth = 0;
    let braceDepth = 0;
    for (let i = openParenIdx; i < text.length; i++) {
      const ch = text[i];
      if (i > 0 && text[i - 1] === '\\') continue;
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
      else if (ch === '(' && braceDepth === 0) parenDepth++;
      else if (ch === ')' && braceDepth === 0) {
        parenDepth--;
        if (parenDepth === 0) return i;
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
