import { Logger } from '@nestjs/common';
import { getDocumentProxy } from 'unpdf';
import {
  cleanAuthorName,
  splitAuthorString,
  cleanAbstractText,
  normalizeAcademicTitleCase,
  isInstitutionName,
} from '@/modules/library/core';

export interface LayoutExtractedFields {
  title?: string;
  authors?: string[];
  abstract?: string;
  maxFontSize?: number;
}

interface PositionedTextLine {
  text: string;
  fontSize: number;
  y: number;
}

/**
 * Geometric Layout & Font-Size Heuristic Extractor.
 * Implements research-proven titling and author zoning heuristics
 * (Beel et al., Docear / JCDL; Tkaczyk et al., CERMINE).
 *
 * Utilizes unpdf (Mozilla PDF.js) affine transform matrices to determine
 * typographic visual hierarchy:
 *   - The largest font size in the top 50% of Page 1 is the Title.
 *   - Lines immediately following the Title and preceding the Abstract belong to Authors.
 */
export class LayoutHeuristicExtractor {
  private static readonly logger = new Logger(LayoutHeuristicExtractor.name);

  public static async extract(
    buffer: Buffer,
    pdfDocument?: Awaited<ReturnType<typeof getDocumentProxy>>,
  ): Promise<LayoutExtractedFields> {
    if (!buffer || buffer.length === 0) return {};

    const ownsDoc = !pdfDocument;
    let doc: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;

    try {
      doc =
        pdfDocument ??
        (await (async () => {
          const cloned = new Uint8Array(buffer.byteLength);
          cloned.set(buffer);
          return getDocumentProxy(cloned);
        })());
      if (!doc || doc.numPages === 0) return {};

      const page = await doc.getPage(1);
      let textContent: Awaited<ReturnType<typeof page.getTextContent>>;
      try {
        textContent = await page.getTextContent();
      } finally {
        try {
          page?.cleanup?.();
        } catch {
          // Ignore page cleanup errors
        }
      }

      const rawItems = textContent.items as Array<{
        str?: string;
        transform?: number[];
        hasEOL?: boolean;
      }>;

      if (!rawItems || rawItems.length === 0) return {};

      const Y_TOLERANCE = 4;
      const COLUMN_SPLIT_X = 295;

      // Detect if the page has a 2-column body layout (items on both left x < 250 and right x >= 305)
      let leftBodyCount = 0;
      let rightBodyCount = 0;
      for (const item of rawItems) {
        if (!item.str || !item.str.trim()) continue;
        const transform = item.transform || [12, 0, 0, 12, 0, 0];
        const fontSize = Math.abs(transform[0]) || Math.abs(transform[3]) || 12;
        const x = Math.round(transform[4] || 0);
        if (fontSize <= 11.5) {
          if (x > 20 && x < 250) leftBodyCount++;
          else if (x >= 305) rightBodyCount++;
        }
      }
      const isTwoColumn = leftBodyCount >= 2 && rightBodyCount >= 2;

      interface LineBucket {
        fragments: Array<{ text: string; x: number }>;
        fontSizes: number[];
        y: number;
        column: 0 | 1; // 0 = header or left column, 1 = right column
      }

      const lineBuckets: LineBucket[] = [];

      for (const item of rawItems) {
        if (!item.str || !item.str.trim()) continue;
        const text = item.str;
        const transform = item.transform || [12, 0, 0, 12, 0, 0];
        const fontSize = Math.abs(transform[0]) || Math.abs(transform[3]) || 12;
        const x = Math.round(transform[4] || 0);
        const y = Math.round(transform[5] || 0);
        const column: 0 | 1 =
          isTwoColumn && fontSize <= 11.5 && x >= COLUMN_SPLIT_X ? 1 : 0;

        let matchedBucket: LineBucket | null = null;
        for (const bucket of lineBuckets) {
          if (
            bucket.column === column &&
            Math.abs(bucket.y - y) <= Y_TOLERANCE
          ) {
            matchedBucket = bucket;
            break;
          }
        }

        if (matchedBucket) {
          matchedBucket.fragments.push({ text, x });
          matchedBucket.fontSizes.push(fontSize);
        } else {
          lineBuckets.push({
            fragments: [{ text, x }],
            fontSizes: [fontSize],
            y,
            column,
          });
        }
      }

      const toPositionedLine = (
        b: LineBucket,
      ): PositionedTextLine & { column: 0 | 1 } => {
        const sortedFragments = [...b.fragments].sort((a, c) => a.x - c.x);
        return {
          text: sortedFragments
            .map((f) => f.text)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),
          fontSize: b.fontSizes.reduce((a, c) => a + c, 0) / b.fontSizes.length,
          y: b.y,
          column: b.column,
        };
      };

      const allLines = lineBuckets.map(toPositionedLine);
      const col0Lines = allLines
        .filter((l) => l.column === 0)
        .sort((a, b) => b.y - a.y);
      const col1Lines = allLines
        .filter((l) => l.column === 1)
        .sort((a, b) => b.y - a.y);
      const lines: PositionedTextLine[] = [...col0Lines, ...col1Lines];

      if (lines.length === 0) return {};

      const candidateLines = lines.filter((l) => {
        const isNoiseHeader =
          /^(arxiv\s*:\s*[a-z0-9\-./]+|proceedings of|ieee|volume|vol\.|accepted|submitted|published|journal of|springer|elsevier|nature|biorxiv)/i.test(
            l.text,
          ) ||
          /^(\d{1,2}\s+[a-z]{3,9}\s+\d{4}|\d{4}\s*[-/]\s*\d{1,2})/i.test(
            l.text,
          ) ||
          l.text.length < 3;
        return !isNoiseHeader;
      });

      if (candidateLines.length === 0) return {};

      let maxFontSize = 0;
      let titleLineIndex = -1;

      for (let i = 0; i < Math.min(candidateLines.length, 12); i++) {
        const line = candidateLines[i];
        if (line.fontSize > maxFontSize && line.text.length >= 8) {
          maxFontSize = line.fontSize;
          titleLineIndex = i;
        }
      }

      if (titleLineIndex === -1) return {};

      let titleAccumulator = candidateLines[titleLineIndex].text;
      let lastTitleIndex = titleLineIndex;

      for (
        let i = titleLineIndex + 1;
        i < Math.min(candidateLines.length, titleLineIndex + 4);
        i++
      ) {
        const nextLine = candidateLines[i];
        if (Math.abs(nextLine.fontSize - maxFontSize) <= maxFontSize * 0.15) {
          titleAccumulator += ' ' + nextLine.text;
          lastTitleIndex = i;
        } else {
          break;
        }
      }

      const cleanTitle = normalizeAcademicTitleCase(
        titleAccumulator.replace(/\s+/g, ' ').trim(),
      );

      let authorTokens: string[] = [];
      let abstractStartIndex = -1;

      for (
        let i = lastTitleIndex + 1;
        i < Math.min(candidateLines.length, lastTitleIndex + 15);
        i++
      ) {
        const line = candidateLines[i];
        if (/^(abstract|summary)\b/i.test(line.text)) {
          abstractStartIndex = i;
          break;
        }

        const lineText = line.text;
        if (
          !isInstitutionName(lineText) &&
          !/@/.test(lineText) &&
          !/^(department|faculty|school|division|institute|university|college|laboratory)/i.test(
            lineText,
          )
        ) {
          const split = splitAuthorString(lineText);
          for (const token of split) {
            const cleaned = cleanAuthorName(token);
            if (
              cleaned.length >= 2 &&
              !isInstitutionName(cleaned) &&
              !/^\d+$/.test(cleaned)
            ) {
              authorTokens.push(cleaned);
            }
          }
        }
      }

      authorTokens = Array.from(new Set(authorTokens));

      let abstractText: string | undefined;
      if (abstractStartIndex !== -1) {
        let absAccumulator = '';
        for (
          let i = abstractStartIndex;
          i < Math.min(candidateLines.length, abstractStartIndex + 20);
          i++
        ) {
          const l = candidateLines[i];
          if (
            /^(index\s+terms|keywords|1\.?\s+introduction|i\.?\s+introduction)\b/i.test(
              l.text,
            )
          ) {
            break;
          }
          absAccumulator += ' ' + l.text;
        }
        const cleaned = cleanAbstractText(
          absAccumulator.replace(/^(abstract|summary)[—:\-\s.]*/i, '').trim(),
        );
        if (cleaned && cleaned.length > 25) {
          abstractText = cleaned;
        }
      }

      return {
        title: cleanTitle.length > 5 ? cleanTitle : undefined,
        authors: authorTokens.length > 0 ? authorTokens : undefined,
        abstract: abstractText,
        maxFontSize,
      };
    } catch (err: unknown) {
      this.logger.debug(
        `LayoutHeuristicExtractor failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {};
    } finally {
      if (ownsDoc && doc) {
        const disposableDoc = doc as {
          cleanup?: () => Promise<void> | void;
          destroy?: () => Promise<void> | void;
        };
        await Promise.resolve(disposableDoc.cleanup?.()).catch(() => {});
        await Promise.resolve(disposableDoc.destroy?.()).catch(() => {});
      }
    }
  }
}
