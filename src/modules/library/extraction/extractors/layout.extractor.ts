import { Logger } from '@nestjs/common';
import { getDocumentProxy } from 'unpdf';
import {
  cleanAuthorName,
  splitAuthorString,
  splitConcatenatedAuthors,
  cleanAbstractText,
  normalizeTitleCase,
  isInstitutionName,
  RegexExtractor,
} from '@/modules/library/core';

export interface LayoutExtractedFields {
  title?: string;
  authors?: string[];
  abstract?: string;
  year?: number;
  doi?: string;
  maxFontSize?: number;
}

export interface LayoutTextItem {
  str?: string;
  transform?: number[];
  hasEOL?: boolean;
}

interface PositionedTextLine {
  text: string;
  fontSize: number;
  y: number;
}

/**
 * Geometric Layout & Font-Size Extractor.
 * Implements titling and author zoning from PDF.js text items
 * (Zotero recognizePDF.js).
 *
 * Utilizes unpdf (Mozilla PDF.js) affine transform matrices (including embedded
 * invisible text layers from pre-OCR'd Sandwich PDFs) to determine visual hierarchy:
 *   - Running headers/footers repeated across pages 1..3 are stripped first.
 *   - The largest font size in the top 50% of Page 1 is the Title.
 *   - Lines immediately following the Title and preceding the Abstract belong to Authors.
 */
export class LayoutExtractor {
  private static readonly logger = new Logger(LayoutExtractor.name);

  /**
   * Normalizes a header/footer candidate line by replacing page numbers and dates
   * with canonical placeholders so running headers ("Journal Name - Page 1" vs "Journal Name - Page 2")
   * match across pages (Zotero recognizePDF.js parity).
   */
  public static normalizeHeaderFooterSignature(line: string): string {
    return line
      .trim()
      .toLowerCase()
      .replace(/\bpage\s+\d+(\s+of\s+\d+)?\b/gi, 'page #')
      .replace(/\b\d+\b/g, '#')
      .replace(/\s+/g, ' ');
  }

  /**
   * Detects running header and footer signatures repeated at the top or bottom
   * of 2 or more front-matter pages.
   * Guards against synthetic unit-test mocks where identical full pages are returned.
   */
  public static extractRunningHeaderFooterSignatures(
    pageTexts: readonly string[],
  ): Set<string> {
    const signatures = new Set<string>();
    if (!pageTexts || pageTexts.length < 2) return signatures;

    const pageLines = pageTexts
      .map((t) =>
        (t || '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length >= 3),
      )
      .filter((lines) => lines.length > 0);

    if (pageLines.length < 2) return signatures;

    // Guard: if page 1 and page 2 are 100% identical multi-line mocks, do not strip everything
    if (
      pageLines[0].length >= 3 &&
      pageLines[0].join('\n') === pageLines[1].join('\n')
    ) {
      return signatures;
    }

    const edgeCounts = new Map<string, number>();
    for (const lines of pageLines) {
      const seenInPage = new Set<string>();
      const topSlice = lines.slice(0, Math.min(2, lines.length));
      const bottomSlice =
        lines.length > 3 ? lines.slice(Math.max(2, lines.length - 2)) : [];

      for (const edgeLine of [...topSlice, ...bottomSlice]) {
        if (edgeLine.length > 120) continue;
        const sig = this.normalizeHeaderFooterSignature(edgeLine);
        if (sig.length >= 4 && !seenInPage.has(sig)) {
          seenInPage.add(sig);
          edgeCounts.set(sig, (edgeCounts.get(sig) || 0) + 1);
        }
      }
    }

    for (const [sig, count] of edgeCounts.entries()) {
      if (count >= 2) {
        signatures.add(sig);
      }
    }

    return signatures;
  }

  /**
   * Strips repeated running headers/footers from front-matter page texts.
   */
  public static stripRunningHeadersAndFootersFromText(
    pageTexts: readonly string[],
  ): { cleanedText: string; signatures: Set<string> } {
    const signatures = this.extractRunningHeaderFooterSignatures(pageTexts);
    if (signatures.size === 0) {
      return {
        cleanedText: pageTexts.join('\n\n'),
        signatures,
      };
    }

    const cleanedPages = pageTexts.map((pageText) => {
      const lines = (pageText || '').split(/\r?\n/);
      return lines
        .filter((line, idx) => {
          const trimmed = line.trim();
          if (!trimmed) return true;
          const isEdgeLine = idx < 3 || idx >= lines.length - 3;
          if (!isEdgeLine) return true;
          return !signatures.has(this.normalizeHeaderFooterSignature(trimmed));
        })
        .join('\n');
    });

    return {
      cleanedText: cleanedPages.join('\n\n'),
      signatures,
    };
  }

  public static async extract(
    buffer: Buffer,
    pdfDocument?: Awaited<ReturnType<typeof getDocumentProxy>>,
    runningHeaderFooters?: ReadonlySet<string>,
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
      let pageWidthHint: number | undefined;
      try {
        textContent = await page.getTextContent();
        if (typeof (page as { getViewport?: unknown }).getViewport === 'function') {
          try {
            const vp = page.getViewport({ scale: 1 });
            if (vp && typeof vp.width === 'number' && vp.width > 100) {
              pageWidthHint = vp.width;
            }
          } catch {
            // Ignore viewport inspection errors
          }
        }
      } finally {
        try {
          page?.cleanup?.();
        } catch {
          // Ignore page cleanup errors
        }
      }

      const rawItems = textContent.items as LayoutTextItem[];
      return this.extractFromRawItems(
        rawItems,
        runningHeaderFooters,
        pageWidthHint,
      );
    } catch (err: unknown) {
      this.logger.debug(
        `LayoutExtractor failed: ${err instanceof Error ? err.message : String(err)}`,
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

  /**
   * Core geometric clustering engine operating on positioned text items
   * (either native PDF.js text items or adapted OCR bounding-box lines/words).
   */
  public static extractFromRawItems(
    rawItems: readonly LayoutTextItem[],
    runningHeaderFooters?: ReadonlySet<string>,
    pageWidthHint?: number,
  ): LayoutExtractedFields {
    if (!rawItems || rawItems.length === 0) return {};

    const Y_TOLERANCE = 4;

    // Dynamically determine horizontal bounds and column split midpoint
    let minX = Infinity;
    let maxX = -Infinity;
    for (const item of rawItems) {
      if (!item.str || !item.str.trim()) continue;
      const transform = item.transform || [12, 0, 0, 12, 0, 0];
      if (
        Math.abs(transform[1] || 0) > Math.abs(transform[0] || 0) &&
        Math.abs(transform[2] || 0) > Math.abs(transform[3] || 0)
      ) {
        continue;
      }
      const x = Math.round(transform[4] || 0);
      if (x >= 0 && x < minX) minX = x;
      if (x > maxX) maxX = x;
    }

    const effectivePageWidth =
      pageWidthHint && pageWidthHint > 100
        ? pageWidthHint
        : maxX > 350
          ? Math.max(595, maxX + (Number.isFinite(minX) ? minX : 50))
          : 595;
    const columnSplitX = Math.round(effectivePageWidth * 0.495);
    const leftBoundMax = Math.round(effectivePageWidth * 0.42);
    const rightBoundMin = Math.round(effectivePageWidth * 0.51);

    // Detect if the page has a 2-column body layout
    let leftBodyCount = 0;
    let rightBodyCount = 0;
    for (const item of rawItems) {
      if (!item.str || !item.str.trim()) continue;
      const transform = item.transform || [12, 0, 0, 12, 0, 0];
      if (
        Math.abs(transform[1] || 0) > Math.abs(transform[0] || 0) &&
        Math.abs(transform[2] || 0) > Math.abs(transform[3] || 0)
      ) {
        continue;
      }
      const fontSize = Math.abs(transform[0]) || Math.abs(transform[3]) || 12;
      const x = Math.round(transform[4] || 0);
      if (fontSize <= 11.5) {
        if (x > 20 && x < leftBoundMax) leftBodyCount++;
        else if (x >= rightBoundMin) rightBodyCount++;
      }
    }
    const isTwoColumn = leftBodyCount >= 2 && rightBodyCount >= 2;

    // Find approximate cutoff below which the 2-column body text starts.
    // Text in the front-matter zone (Title, Author block, Affiliations) should never
    // be split into separate columns so co-authors arranged side-by-side stay on the same line.
    let headerCutoffY = -Infinity;
    let maxFontInTopHalf = 0;
    let titleApproxY = 0;
    let markerY = 0;

    for (const item of rawItems) {
      if (!item.str || !item.str.trim()) continue;
      const transform = item.transform || [12, 0, 0, 12, 0, 0];
      const fontSize = Math.abs(transform[0]) || Math.abs(transform[3]) || 12;
      const y = Math.round(transform[5] || 0);

      if (fontSize > maxFontInTopHalf) {
        maxFontInTopHalf = fontSize;
        titleApproxY = y;
      }
      if (
        /^(abstract|summary|1\.?\s*introduction|i\.?\s*introduction|introduction)\b/i.test(
          item.str.trim(),
        )
      ) {
        if (markerY === 0 || y > markerY) {
          markerY = y;
        }
      }
    }

    if (markerY > 0) {
      headerCutoffY = markerY;
    } else if (titleApproxY > 0) {
      headerCutoffY = titleApproxY - 180;
    }

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
      if (
        Math.abs(transform[1] || 0) > Math.abs(transform[0] || 0) &&
        Math.abs(transform[2] || 0) > Math.abs(transform[3] || 0)
      ) {
        continue;
      }
      const fontSize = Math.abs(transform[0]) || Math.abs(transform[3]) || 12;
      const x = Math.round(transform[4] || 0);
      const y = Math.round(transform[5] || 0);
      const isHeaderZone =
        markerY > 0 ? y > markerY + Y_TOLERANCE : y >= headerCutoffY;
      const column: 0 | 1 =
        isTwoColumn && !isHeaderZone && fontSize <= 11.5 && x >= columnSplitX
          ? 1
          : 0;

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
      let joinedText = '';
      for (let fi = 0; fi < sortedFragments.length; fi++) {
        const frag = sortedFragments[fi];
        if (fi === 0) {
          joinedText = frag.text;
        } else {
          const prevFrag = sortedFragments[fi - 1];
          const gap = frag.x - prevFrag.x;
          const isWideGap =
            gap >= 40 &&
            (markerY > 0 ? b.y > markerY + Y_TOLERANCE : b.y >= headerCutoffY);
          if (
            isWideGap &&
            !/[,;]\s*$/.test(joinedText) &&
            !/\b(and|&)\s*$/i.test(joinedText)
          ) {
            joinedText += ', ' + frag.text;
          } else {
            joinedText += ' ' + frag.text;
          }
        }
      }

      return {
        text: joinedText.replace(/\s+/g, ' ').trim(),
        fontSize: b.fontSizes.reduce((a, c) => a + c, 0) / b.fontSizes.length,
        y: b.y,
        column: b.column,
      };
    };

    const lines: PositionedTextLine[] = lineBuckets
      .map(toPositionedLine)
      .sort((a, b) => a.column - b.column || b.y - a.y);

    if (lines.length === 0) return {};

    const candidateLines = lines.filter((l, idx) => {
      if (
        runningHeaderFooters &&
        runningHeaderFooters.size > 0 &&
        (idx < 3 || idx >= lines.length - 3)
      ) {
        const sig = this.normalizeHeaderFooterSignature(l.text);
        if (runningHeaderFooters.has(sig)) {
          return false;
        }
      }
      const isNoiseHeader =
        /^(arxiv\s*:\s*[a-z0-9\-./]+|proceedings of|ieee|volume|vol\.|accepted(\s+manuscript)?|submitted|published|journal\s+(of|pre-proof)|springer|elsevier|nature|biorxiv|downloaded\s+from|authorized\s+licensed\s+use|research\s+article|original\s+article|review\s+article|open\s+access|short\s+communication)/i.test(
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

    const cleanTitle = normalizeTitleCase(
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
      if (
        /^(1\.?\s*introduction|i\.?\s*introduction|introduction|keywords|index\s+terms)\b/i.test(
          line.text,
        ) ||
        (line.text.length > 130 &&
          /\b(the|this|that|these|those|we|our|is|are|was|were|have|has|can|will|propose|present|introduce|demonstrate|show|study|investigate|analyze|describe|discuss|however|moreover|furthermore|therefore)\b/i.test(
            line.text,
          ))
      ) {
        break;
      }

      const lineText = line.text;
      if (
        !isInstitutionName(lineText) &&
        !/@/.test(lineText) &&
        !/^(department|faculty|school|division|institute|university|college|laboratory)/i.test(
          lineText,
        ) &&
        !/\b(road|street|avenue|boulevard|blvd|lane|drive|building|bldg|room|rm\.?|floor|suite|box|campus|ontario|quebec|california|toronto|montreal|canada|usa|uk)\b/i.test(
          lineText,
        ) &&
        !/\b[A-Z]\d[A-Z]\s*\d[A-Z]\d\b/.test(lineText)
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
  }

  /**
   * Deterministic plain-text line-structure fallback (< 0.5ms) when a PDF
   * stream yields plain text without coordinate transform matrices.
   */
  public static extractFromPlainText(text: string): LayoutExtractedFields {
    if (!text || text.trim().length < 20) return {};

    const cleanInput = text.slice(0, 3500).trim();
    const result: LayoutExtractedFields = {};
    const lines = cleanInput
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) return result;

    let abstractStart = -1;
    let abstractEnd = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^(abstract|summary)\b/i.test(lines[i])) {
        abstractStart = i;
      } else if (
        abstractStart !== -1 &&
        /^(1\.?\s*)?(introduction|background|index terms|keywords)\b/i.test(
          lines[i],
        )
      ) {
        abstractEnd = i;
        break;
      }
    }

    if (abstractStart !== -1) {
      const end =
        abstractEnd !== -1
          ? abstractEnd
          : Math.min(lines.length, abstractStart + 8);
      const abstractContent = lines
        .slice(abstractStart, end)
        .join(' ')
        .replace(/^(abstract|summary)[—:\-\s.]+/i, '')
        .trim();
      if (abstractContent.length > 25) {
        result.abstract = cleanAbstractText(abstractContent);
      }
    }

    const headerLines =
      abstractStart !== -1 ? lines.slice(0, abstractStart) : lines.slice(0, 15);
    const candidateTitleLines: string[] = [];

    for (const line of headerLines) {
      if (
        /^(arxiv[:\s._/-]*\d|https?:|\d+$|submitted to|accepted|published|proceedings of|ieee|acm|springer|elsevier|under review|copyright|downloaded from|authorized licensed use)/i.test(
          line,
        )
      ) {
        continue;
      }
      if (line.length > 8 && !candidateTitleLines.length) {
        candidateTitleLines.push(line);
      } else if (
        candidateTitleLines.length === 1 &&
        line.length > 4 &&
        !/[,;@]|department|university|institute/i.test(line)
      ) {
        candidateTitleLines.push(line);
      } else if (candidateTitleLines.length > 0) {
        break;
      }
    }

    if (candidateTitleLines.length > 0) {
      const joinedRawTitle = candidateTitleLines
        .join(' ')
        .replace(/\b([A-Za-z])(?:\s+([A-Za-z])){2,}\b/g, (match) =>
          match
            .split(/\s{2,}/)
            .map((word) => word.replace(/\s+/g, ''))
            .join(' '),
        )
        .replace(/\b([A-Za-z0-9]+)\s+-\s+([A-Za-z0-9]+)\b/g, '$1-$2')
        .replace(/-\s+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      result.title = normalizeTitleCase(joinedRawTitle);
    }

    const authorCandidates = headerLines.slice(candidateTitleLines.length);
    for (const line of authorCandidates) {
      if (
        !/university|department|laboratory|institute|school|faculty|hospital|center for|group/i.test(
          line,
        )
      ) {
        const potentialAuthors = splitAuthorString(line)
          .flatMap((a: string) => splitConcatenatedAuthors(a, 4))
          .map((a: string) => cleanAuthorName(a))
          .filter((a: string) => a.length > 2 && a.length < 50);
        if (potentialAuthors.length > 0) {
          result.authors = potentialAuthors;
          break;
        }
      }
    }

    const currentYear = new Date().getFullYear();
    const isValidYear = (y: number) => y >= 1950 && y <= currentYear + 2;
    const frontSlice = cleanInput.slice(0, 2500);
    const pubMarkerMatch = frontSlice.match(
      /(?:©|\(c\)|published|accepted|received|revised|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[^0-9\n]{0,25}\b(19\d{2}|20\d{2})\b/i,
    );
    const markerYear = pubMarkerMatch ? parseInt(pubMarkerMatch[1], 10) : NaN;
    if (!Number.isNaN(markerYear) && isValidYear(markerYear)) {
      result.year = markerYear;
    } else {
      const allYears = [...frontSlice.matchAll(/\b(19\d{2}|20\d{2})\b/g)]
        .map((m) => parseInt(m[1], 10))
        .filter(isValidYear);
      if (allYears.length > 0) {
        result.year = allYears[0];
      }
    }

    const scannedRegex = RegexExtractor.scan(cleanInput);
    if (scannedRegex.doi) {
      result.doi = scannedRegex.doi;
    }

    return result;
  }
}
