/**
 * modules/manuscripts/docstore/core/adapters/engine/line-array.engine.ts
 * High-performance line-array manipulation, CRLF normalization, BOM stripping,
 * null-byte defensive guard, and splice operations.
 * Matches Overleaf DocManager and HttpController line processing.
 */

import { DocTooLargeError, NullByteDetectedError } from '../../domain/doc-errors';

export class LineArrayEngine {
  public static readonly DEFAULT_MAX_DOC_LENGTH = 2 * 1024 * 1024; // 2MB default text limit (Overleaf parity)

  /**
   * Converts raw string to lines array with strict sanitization:
   * 1. Strips UTF-8 BOM (\ufeff).
   * 2. Checks for \u0000 null byte (defensive check against memory corruption).
   * 3. Normalizes all CRLF (\r\n) and CR (\r) line breaks to Unix LF (\n).
   * 4. Enforces maximum document size.
   */
  public static textToLines(rawText: string, maxDocLength: number = LineArrayEngine.DEFAULT_MAX_DOC_LENGTH): string[] {
    if (!rawText) return [''];

    // 1. Strip UTF-8 BOM if present
    const cleanText = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;

    // 2. Defensive check for null bytes
    if (cleanText.indexOf('\u0000') !== -1) {
      throw new NullByteDetectedError('Null byte (\\u0000) detected in document text');
    }

    // 3. Size check
    const byteLength = Buffer.byteLength(cleanText, 'utf8');
    if (byteLength > maxDocLength) {
      throw new DocTooLargeError(byteLength, maxDocLength);
    }

    // 4. Normalize newlines to Unix LF and split
    return cleanText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  }

  /**
   * Joins lines array into single raw text string with Unix LF (\n).
   */
  public static linesToText(lines: string[]): string {
    if (!lines || lines.length === 0) return '';
    return lines.join('\n');
  }

  /**
   * Validates lines array byte size against maximum limit.
   */
  public static validateLinesSize(lines: string[], maxDocLength: number = LineArrayEngine.DEFAULT_MAX_DOC_LENGTH): number {
    let totalChars = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.indexOf('\u0000') !== -1) {
        throw new NullByteDetectedError(`Null byte detected on line ${i + 1}`);
      }
      totalChars += line.length;
    }
    const totalBytes = totalChars + Math.max(0, lines.length - 1);
    if (totalBytes > maxDocLength) {
      throw new DocTooLargeError(totalBytes, maxDocLength);
    }
    return totalBytes;
  }

  /**
   * Applies an in-place splice operation on the lines array.
   */
  public static applySplice(
    currentLines: string[],
    startLine: number,
    deleteCount: number,
    newLines: string[]
  ): string[] {
    const updated = [...currentLines];
    const safeStart = Math.max(0, Math.min(startLine, updated.length));
    updated.splice(safeStart, deleteCount, ...newLines);
    return updated;
  }
}
