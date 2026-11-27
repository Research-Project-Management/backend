/**
 * citations/domain/bibtex-parser.domain.ts
 * BibTeX parser powered by `@citation-js/plugin-bibtex` with in-place span upserts.
 */

import { plugins } from '@citation-js/core';
import '@citation-js/plugin-bibtex';
import { IBibtexParserPort } from './citations.ports';
import { BibEntry } from './bib-entry.domain';
import { CitationKeyVo } from './value-objects.domain';

export type ConflictPolicy = 'overwrite' | 'skip' | 'rename';

interface CitationJsRawBibtexEntry {
  type?: string;
  label?: string;
  properties?: Record<string, unknown>;
}

export class BibtexParser implements IBibtexParserPort {
  /**
   * Parse a raw BibTeX string into an array of BibEntry entities using `@citation-js/plugin-bibtex`.
   */
  public parse(rawBibtex: string): BibEntry[] {
    if (!rawBibtex || typeof rawBibtex !== 'string') return [];

    let rawEntries: CitationJsRawBibtexEntry[] = [];
    try {
      const stripped = BibtexParser.maskCommentsPreserveLength(rawBibtex);
      const parsed = plugins.input.chainLink(stripped);
      if (Array.isArray(parsed)) {
        rawEntries = parsed as CitationJsRawBibtexEntry[];
      }
    } catch {
      return [];
    }

    const entries: BibEntry[] = [];
    for (const item of rawEntries) {
      const entryType = (item.type || '').toLowerCase();
      const rawKey = (item.label || '').trim();
      if (
        !entryType ||
        !rawKey ||
        entryType === 'comment' ||
        entryType === 'preamble' ||
        entryType === 'string'
      ) {
        continue;
      }

      const fields: Record<string, string> = {};
      if (item.properties && typeof item.properties === 'object') {
        for (const [k, v] of Object.entries(item.properties)) {
          const fieldName = k.toLowerCase().trim();
          if (!fieldName || v === null || v === undefined) continue;
          const strVal = String(v).replace(/\s+/g, ' ').trim();
          if (strVal.length > 0) {
            fields[fieldName] = strVal;
          }
        }
      }

      try {
        const sanitizedKey = CitationKeyVo.sanitize(rawKey);
        entries.push(
          new BibEntry({
            key: sanitizedKey || rawKey,
            entryType,
            fields,
          }),
        );
      } catch {
        // Skip entry if key is invalid
      }
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
  ): {
    text: string;
    conflicts: string[];
    renamedKeys: Record<string, string>;
  } {
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
}

export { BibtexParser as RegexAstBibtexParser };
