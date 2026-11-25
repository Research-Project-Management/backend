

/**
 * citations/domain/bibtex.parser.ts
 * Zero-dependency, pure TypeScript BibTeX parser and serializer.
 * Robust against nested braces, multiline fields, quotes, and comments.
 */

import { IBibtexParserPort } from './citations.ports';
import { BibEntry } from './bib-entry.domain';
import { CitationKeyVo } from './value-objects.domain';

export type ConflictPolicy = 'overwrite' | 'skip' | 'rename';

export class BibtexParser implements IBibtexParserPort {
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
      ...BibtexParser.STANDARD_MONTH_MACROS,
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
  public static findMatchingClosingBrace(
    text: string,
    openBraceIdx: number,
  ): number {
    let depth = 0;
    for (let i = openBraceIdx; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return i;
        }
      }
    }
    return -1;
  }

  public static maskCommentsPreserveLength(text: string): string {
    return BibtexParser.scanComments(text, true);
  }

  /**
   * Single-pass O(N) comment scanner that only treats unescaped '%' as a comment
   * when outside braces (braceDepth === 0) and outside quotes.
   * Preserves '%' inside URLs (e.g. %20) and abstracts (e.g. 20%).
   */
  private static scanComments(text: string, preserveLength: boolean): string {
    if (!text) return '';
    const chunks: string[] = [];
    let chunkStart = 0;
    let braceDepth = 0;
    let inQuotes = false;
    let i = 0;

    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '{') {
        braceDepth++;
        i++;
        continue;
      }
      if (ch === '}') {
        if (braceDepth > 0) braceDepth--;
        i++;
        continue;
      }
      if (ch === '"' && braceDepth === 0) {
        inQuotes = !inQuotes;
        i++;
        continue;
      }
      if (ch === '%' && braceDepth === 0 && !inQuotes) {
        if (i > chunkStart) {
          chunks.push(text.slice(chunkStart, i));
        }
        let lineEnd = text.indexOf('\n', i);
        if (lineEnd === -1) lineEnd = text.length;
        if (preserveLength) {
          chunks.push(' '.repeat(lineEnd - i));
        }
        i = lineEnd;
        chunkStart = i;
        continue;
      }
      i++;
    }

    if (chunkStart < text.length) {
      chunks.push(text.slice(chunkStart));
    }
    return chunks.join('');
  }

  /**
   * Single-pass O(N + M) batch upsert of BibTeX entries into an existing .bib text.
   * Supports both @type{key, ...} and @type(key, ...) delimiters, preserves comments,
   * and supports conflict resolution policies ('overwrite' | 'skip' | 'rename').
   */
  public static upsertEntriesBatch(
    text: string,
    entries: Array<{ key: string; bibString: string }>,
    conflictPolicy: ConflictPolicy = 'overwrite',
  ): { text: string; conflicts: string[]; renamedKeys: Record<string, string> } {
    if (entries.length === 0) {
      return { text, conflicts: [], renamedKeys: {} };
    }

    // Deduplicate incoming batch by normalized key (last-write-wins) while preserving order
    const incomingOrder: string[] = [];
    const incomingMap = new Map<string, { key: string; bibString: string }>();
    for (const item of entries) {
      const norm = item.key.trim().toLowerCase();
      if (!incomingMap.has(norm)) {
        incomingOrder.push(norm);
      }
      incomingMap.set(norm, item);
    }

    const maskedText = BibtexParser.maskCommentsPreserveLength(text);
    const keyToSpans = new Map<string, Array<{ start: number; end: number }>>();
    const entryStartRegex = /@([a-zA-Z]+)\s*([{(])\s*([^,\s}()]+)\s*,/g;

    let match: RegExpExecArray | null;
    while ((match = entryStartRegex.exec(maskedText)) !== null) {
      const entryType = match[1].toLowerCase();
      if (
        entryType === 'comment' ||
        entryType === 'preamble' ||
        entryType === 'string'
      ) {
        continue;
      }
      const openDelim = match[2];
      const openIdx = match.index + match[0].indexOf(openDelim);
      const closeIdx =
        openDelim === '('
          ? BibtexParser.findMatchingClosingParenStatic(maskedText, openIdx)
          : BibtexParser.findMatchingClosingBrace(maskedText, openIdx);
      if (closeIdx === -1) break;

      const normKey = match[3].trim().toLowerCase();
      let spans = keyToSpans.get(normKey);
      if (!spans) {
        spans = [];
        keyToSpans.set(normKey, spans);
      }
      spans.push({ start: match.index, end: closeIdx + 1 });
      entryStartRegex.lastIndex = closeIdx + 1;
    }

    const usedKeys = new Set<string>(keyToSpans.keys());
    const conflicts: string[] = [];
    const renamedKeys: Record<string, string> = {};
    const ops: Array<{
      start: number;
      end: number;
      replacement: string;
      stripTrailingWs: boolean;
    }> = [];
    const toAppend: string[] = [];

    for (const norm of incomingOrder) {
      const item = incomingMap.get(norm)!;
      const spans = keyToSpans.get(norm);
      if (spans && spans.length > 0) {
        conflicts.push(item.key);
        if (conflictPolicy === 'skip') {
          continue;
        }
        if (conflictPolicy === 'rename') {
          let suffix = 2;
          let candidate = `${item.key}_${suffix}`;
          while (usedKeys.has(candidate.toLowerCase())) {
            suffix++;
            candidate = `${item.key}_${suffix}`;
          }
          usedKeys.add(candidate.toLowerCase());
          renamedKeys[item.key] = candidate;
          const renamedBib = item.bibString.replace(
            /^(@[a-zA-Z]+\s*[{(]\s*)([^,\s}()]+)(\s*,)/,
            `$1${candidate}$3`,
          );
          toAppend.push(renamedBib);
          continue;
        }
        // Default: 'overwrite'
        spans.forEach((span, idx) => {
          ops.push({
            start: span.start,
            end: span.end,
            replacement: idx === 0 ? item.bibString : '',
            stripTrailingWs: idx > 0,
          });
        });
      } else {
        usedKeys.add(norm);
        toAppend.push(item.bibString);
      }
    }

    let patched = text;
    if (ops.length > 0) {
      ops.sort((a, b) => a.start - b.start);
      const chunks: string[] = [];
      let cursor = 0;
      for (const op of ops) {
        if (op.start < cursor) continue;
        chunks.push(text.slice(cursor, op.start));
        if (op.replacement) {
          chunks.push(op.replacement);
          cursor = op.end;
        } else {
          let nextCursor = op.end;
          if (op.stripTrailingWs) {
            while (nextCursor < text.length && /\s/.test(text[nextCursor])) {
              nextCursor++;
            }
          }
          cursor = nextCursor;
        }
      }
      chunks.push(text.slice(cursor));
      patched = chunks.join('');
    }

    if (toAppend.length > 0) {
      const trimmed = patched.replace(/\s+$/, '');
      const appendedBlock = toAppend.join('\n\n');
      patched = trimmed
        ? `${trimmed}\n\n${appendedBlock}\n`
        : `${appendedBlock}\n`;
    }

    return { text: patched, conflicts, renamedKeys };
  }

  public static upsertEntry(
    text: string,
    key: string,
    bibString: string,
  ): string {
    return BibtexParser.upsertEntriesBatch(text, [{ key, bibString }]).text;
  }

  private findMatchingClosingBrace(text: string, openBraceIdx: number): number {
    return BibtexParser.findMatchingClosingBrace(text, openBraceIdx);
  }

  /**
   * Finds the closing parenthesis corresponding to an opening parenthesis at openParenIdx
   * (for @article(...) or @string(...) entries).
   */
  public static findMatchingClosingParenStatic(
    text: string,
    openParenIdx: number,
  ): number {
    let parenDepth = 0;
    let braceDepth = 0;
    for (let i = openParenIdx; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\\') {
        i++;
        continue;
      }
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

  private findMatchingClosingParen(text: string, openParenIdx: number): number {
    return BibtexParser.findMatchingClosingParenStatic(text, openParenIdx);
  }

  /**
   * Strip LaTeX/BibTeX comments (% to end of line) only outside braces/quotes.
   */
  private stripComments(text: string): string {
    return BibtexParser.scanComments(text, false);
  }
}

export { BibtexParser as RegexAstBibtexParser };

