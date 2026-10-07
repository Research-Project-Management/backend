import { Injectable, Logger } from '@nestjs/common';
import { getDocumentProxy } from 'unpdf';
import {
  cleanAuthorName,
  splitAuthorString,
  cleanAbstractText,
  normalizeAcademicTitleCase,
  isInstitutionName,
} from '../../shared-kernel/utils/bibliographic.utils';

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
@Injectable()
export class LayoutHeuristicExtractor {
  private static readonly logger = new Logger(LayoutHeuristicExtractor.name);

  public static async extract(buffer: Buffer): Promise<LayoutExtractedFields> {
    if (!buffer || buffer.length === 0) return {};

    try {
      const cloned = new Uint8Array(buffer.byteLength);
      cloned.set(buffer);

      const doc = await getDocumentProxy(cloned);
      if (!doc || doc.numPages === 0) return {};

      const page = await doc.getPage(1);
      const textContent = await page.getTextContent();
      const viewport =
        typeof page.getViewport === 'function'
          ? page.getViewport({ scale: 1.0 })
          : { width: 612, height: 792 };

      const rawItems = textContent.items as Array<{
        str?: string;
        transform?: number[];
        hasEOL?: boolean;
      }>;

      if (!rawItems || rawItems.length === 0) return {};

      const lineMap = new Map<
        number,
        { text: string; fontSizes: number[]; y: number }
      >();
      const Y_TOLERANCE = 4;

      for (const item of rawItems) {
        if (!item.str || !item.str.trim()) continue;
        const text = item.str;
        const transform = item.transform || [12, 0, 0, 12, 0, 0];
        const fontSize = Math.abs(transform[0]) || Math.abs(transform[3]) || 12;
        const y = Math.round(transform[5] || 0);

        let matchedY: number | null = null;
        for (const existingY of lineMap.keys()) {
          if (Math.abs(existingY - y) <= Y_TOLERANCE) {
            matchedY = existingY;
            break;
          }
        }

        if (matchedY !== null) {
          const line = lineMap.get(matchedY)!;
          line.text += ' ' + text;
          line.fontSizes.push(fontSize);
        } else {
          lineMap.set(y, {
            text,
            fontSizes: [fontSize],
            y,
          });
        }
      }

      const lines: PositionedTextLine[] = Array.from(lineMap.values())
        .map((l) => ({
          text: l.text.replace(/\s+/g, ' ').trim(),
          fontSize: l.fontSizes.reduce((a, b) => a + b, 0) / l.fontSizes.length,
          y: l.y,
        }))
        .sort((a, b) => b.y - a.y);

      if (lines.length === 0) return {};

      const candidateLines = lines.filter((l) => {
        const isNoiseHeader =
          /^(arxiv:\s*\d|proceedings of|ieee|volume|vol\.|accepted|submitted)/i.test(
            l.text,
          ) || l.text.length < 3;
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
    }
  }
}
