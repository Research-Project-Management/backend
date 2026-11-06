import { getDocumentProxy } from 'unpdf';
import { splitAuthorString, cleanAuthorName, normalizeDoi, normalizeArxivId } from '@/modules/library/core';
import type { DocumentSection, BibliographicReference } from '@/modules/library/core/types/bibliographic.types';
import { Logger } from '@nestjs/common';
import { inflateSync, inflateRawSync } from 'zlib';
import { decodeHtmlEntities } from '@/modules/library/core/domain/text.domain';
import { normalizeTags } from '@/modules/library/core/domain/tag.domain';
import { RawXmpMetadata } from '@/modules/library/core/types/extraction.types';

export type ExtractedPdfBibliographyReference = BibliographicReference & {
  rawText: string;
};

export function extractPdfBibliographyReferences(
  fullText: string,
): ExtractedPdfBibliographyReference[] {
  if (!fullText || fullText.trim().length < 20) return [];

  const normalizedText = fullText.normalize('NFKC');
  const headingPattern =
    /(?:^|\n)[^\S\r\n]*(?:(?:\d+(?:\.\d+)*\.?|[IVX]+\.?)\s+)?(?:references|bibliography|literature\s+cited|works\s+cited|tài\s+liệu\s+tham\s+khảo)\b([^\r\n]*)/gi;
  let refBodyStart = -1;

  for (const match of normalizedText.matchAll(headingPattern)) {
    const idx = match.index ?? -1;
    if (idx === -1) continue;
    const trailing = (match[1] || '').trim();
    if (trailing !== '' && trailing !== ':') {
      continue;
    }
    const afterHeadingIdx = idx + match[0].length;
    const previewAfter = normalizedText.slice(afterHeadingIdx, afterHeadingIdx + 80);
    if (
      /^(?:\r?\n)?\s*(?:[.\u2026·]{2,}\s*\d+|\d{1,4}\s*(?:\r?\n|$))/.test(
        previewAfter,
      )
    ) {
      continue;
    }
    refBodyStart = afterHeadingIdx;
  }

  if (refBodyStart === -1) return [];

  let refSection = normalizedText.slice(refBodyStart);
  const stopMatch = refSection.match(
    /\n[^\S\r\n]*(?:(?:appendix|appendices|supplementary\s+material|acknowledg(?:e)?ments?|author\s+contributions?|competing\s+interests?|phụ\s+lục|lời\s+cảm\s+ơn)\b|[A-ZÀ-Ỹ]\.\s+[A-ZÀ-Ỹ][A-Za-zÀ-ỹ\s]{3,50})\s*(?:\r?\n|$)/iu,
  );
  if (stopMatch && stopMatch.index !== undefined && stopMatch.index > 60) {
    refSection = refSection.slice(0, stopMatch.index);
  }

  const lines = refSection
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return true;
      if (/^(?:page\s+)?\d+(?:\s+of\s+\d+)?$/i.test(l)) return false;
      return true;
    });

  const rawEntries: string[] = [];
  const numberedStartRe = /^(?:\[\d{1,4}\]|\d{1,4}\.(?=\s+[A-Z"\u201C]))\s*/;
  const authorYearStartRe =
    /^[A-ZÀ-Ỹ][A-Za-zÀ-ỹ'-]+,\s*(?:[A-Z]\.|[A-ZÀ-Ỹ][A-Za-zÀ-ỹ'-]+)\b.*?\b(?:19\d{2}|20\d{2})[a-z]?\b/;

  const hasNumberedEntries = lines.some((l) => numberedStartRe.test(l));
  let currentEntry = '';

  for (const line of lines) {
    if (!line) {
      if (!hasNumberedEntries && currentEntry.trim().length > 15) {
        rawEntries.push(currentEntry.trim());
        currentEntry = '';
      }
      continue;
    }

    if (hasNumberedEntries) {
      if (numberedStartRe.test(line)) {
        if (currentEntry.trim().length > 12) {
          rawEntries.push(currentEntry.trim());
        }
        currentEntry = line;
      } else if (currentEntry) {
        currentEntry = currentEntry.endsWith('-')
          ? `${currentEntry.slice(0, -1)}${line}`
          : `${currentEntry} ${line}`;
      }
    } else {
      if (authorYearStartRe.test(line) && currentEntry.trim().length > 25) {
        rawEntries.push(currentEntry.trim());
        currentEntry = line;
      } else {
        currentEntry = currentEntry
          ? currentEntry.endsWith('-')
            ? `${currentEntry.slice(0, -1)}${line}`
            : `${currentEntry} ${line}`
          : line;
      }
    }
  }

  if (currentEntry.trim().length > 12) {
    rawEntries.push(currentEntry.trim());
  }

  const results: ExtractedPdfBibliographyReference[] = [];
  const maxEntries = 250;

  for (let i = 0; i < Math.min(rawEntries.length, maxEntries); i++) {
    const raw = rawEntries[i].replace(/\s+/g, ' ').trim();
    if (raw.length < 15) continue;

    const bodyWithoutMarker = raw.replace(numberedStartRe, '').trim();
    const doiMatch = bodyWithoutMarker.match(
      /\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9<>+=[\]~]+)/i,
    );
    const doi = doiMatch?.[1] ? normalizeDoi(doiMatch[1]) : undefined;
    const arxivMatch = bodyWithoutMarker.match(
      /(?:arxiv\s*[:./]\s*(?:abs\/|pdf\/)?|10\.48550\/arxiv\.)(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?\/\d{7}(?:v\d+)?)/i,
    );
    const arxivId = arxivMatch?.[1]
      ? normalizeArxivId(arxivMatch[1])
      : undefined;

    const yearMatch = bodyWithoutMarker.match(
      /\b(19\d{2}|20[0-2]\d)[a-z]?\b/,
    );
    const year = yearMatch?.[1] ? parseInt(yearMatch[1], 10) : undefined;

    let title: string | undefined;
    const quotedTitleMatch = bodyWithoutMarker.match(
      /[""\u201C]([^""\u201D]{8,250})[""\u201D]/,
    );
    if (quotedTitleMatch?.[1]) {
      title = quotedTitleMatch[1].replace(/[.,;]+$/, '').trim();
    } else {
      const afterYearDot = bodyWithoutMarker.match(
        /\(\s*(?:19\d{2}|20[0-2]\d)[a-z]?\s*\)\.\s+([^.]{10,250})\./,
      );
      if (afterYearDot?.[1]) {
        title = afterYearDot[1].trim();
      } else {
        const sentences = bodyWithoutMarker
          .split(/\.\s+/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (sentences.length >= 2) {
          const candidate = sentences[1].replace(/[.,;]+$/, '').trim();
          if (
            candidate.length >= 10 &&
            candidate.length <= 250 &&
            !/^(?:in\s+proc|proc\.|ieee|acm|arxiv|vol\.|pp\.|doi\b|http)/i.test(
              candidate,
            )
          ) {
            title = candidate;
          }
        }
      }
    }

    const authors: string[] = [];
    const authorPrefixEnd = quotedTitleMatch?.index
      ? quotedTitleMatch.index
      : bodyWithoutMarker.search(/\(\s*(?:19\d{2}|20[0-2]\d)/) > 3
        ? bodyWithoutMarker.search(/\(\s*(?:19\d{2}|20[0-2]\d)/)
        : bodyWithoutMarker.indexOf('. ') > 3
          ? bodyWithoutMarker.indexOf('. ')
          : -1;

    if (authorPrefixEnd > 3) {
      const rawAuthorSegment = bodyWithoutMarker
        .slice(0, authorPrefixEnd)
        .replace(/\bet\s+al\.?/gi, '')
        .replace(/[.,;:\s]+$/, '')
        .trim();
      if (rawAuthorSegment.length >= 3 && rawAuthorSegment.length <= 220) {
        const splitCandidates = splitAuthorString(rawAuthorSegment)
          .map((a) => cleanAuthorName(a))
          .filter((a) => a.length >= 3 && !/^\d+$/.test(a));
        if (splitCandidates.length > 0) {
          authors.push(...splitCandidates.slice(0, 12));
        }
      }
    }

    results.push({
      id: `ref-${i + 1}`,
      title,
      authors,
      year,
      doi,
      arxivId,
      rawCitation: raw,
      rawText: raw,
    });
  }

  return results;
}

export async function extractPdfOutlineSections(
  document: Awaited<ReturnType<typeof getDocumentProxy>>,
  pages: Array<{
    pageIndex: number;
    pageNumber?: number;
    textContent: string;
  }>,
): Promise<DocumentSection[]> {
  const sections: DocumentSection[] = [];
  const docProxy = document as unknown as {
    getOutline?: () => Promise<
      Array<{ title?: string; dest?: unknown; items?: unknown[] }> | null
    >;
    getDestination?: (dest: string) => Promise<unknown[] | null>;
    getPageIndex?: (ref: unknown) => Promise<number>;
  };

  try {
    if (typeof docProxy.getOutline === 'function') {
      const outline = await docProxy.getOutline();
      if (Array.isArray(outline) && outline.length > 0) {
        const resolvePageNum = async (dest: unknown): Promise<number> => {
          try {
            let explicitDest = dest;
            if (
              typeof dest === 'string' &&
              typeof docProxy.getDestination === 'function'
            ) {
              explicitDest = await docProxy.getDestination(dest);
            }
            if (Array.isArray(explicitDest) && explicitDest.length > 0) {
              const ref = explicitDest[0];
              if (typeof ref === 'number') return ref + 1;
              if (
                ref &&
                typeof ref === 'object' &&
                typeof docProxy.getPageIndex === 'function'
              ) {
                const idx = await docProxy.getPageIndex(ref);
                if (typeof idx === 'number' && idx >= 0) return idx + 1;
              }
            }
          } catch {
            // Ignore destination resolution error
          }
          return 1;
        };

        let sectionCounter = 0;
        const traverseOutline = async (
          items: Array<{ title?: string; dest?: unknown; items?: unknown[] }>,
          level: number,
          prefix: string,
        ) => {
          const pageNums = await Promise.all(
            items.map((item) => {
              const rawTitle =
                typeof item?.title === 'string'
                  ? item.title.replace(/\s+/g, ' ').trim()
                  : '';
              return rawTitle ? resolvePageNum(item.dest) : Promise.resolve(1);
            }),
          );
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const rawTitle =
              typeof item?.title === 'string'
                ? item.title.replace(/\s+/g, ' ').trim()
                : '';
            const num = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
            if (rawTitle) {
              sectionCounter++;
              const pageNum = pageNums[i] ?? 1;
              sections.push({
                id: `sec-${sectionCounter}`,
                num,
                title: rawTitle,
                level,
                page: pageNum,
                pageNumber: pageNum,
                paragraphs: [],
              });
            }
            if (Array.isArray(item?.items) && item.items.length > 0) {
              await traverseOutline(
                item.items as Array<{
                  title?: string;
                  dest?: unknown;
                  items?: unknown[];
                }>,
                level + 1,
                num,
              );
            }
          }
        };

        await traverseOutline(outline, 1, '');
        if (sections.length > 0) return sections;
      }
    }
  } catch {
    // Fallback to heading heuristics below
  }

  const numberedHeadingRegex =
    /^(?:([1-9]\d?(?:\.\d+){0,2}|[IVX]{1,4})\.?\s+)([A-ZÀ-Ỹ][A-Za-zÀ-ỹ0-9\s,:;()\-–—/]{2,80})$/u;
  const canonicalHeadingRegex =
    /^(Abstract|Introduction|Background|Related Work|Literature Review|Methodology|Methods|Materials and Methods|Experiments|Experimental Setup|Results|Results and Discussion|Evaluation|Discussion|Limitations|Conclusion|Conclusions|Future Work|Acknowledgments|Acknowledgements|References|Bibliography|Appendix|Appendices|Supplementary Material|Tóm tắt|Đặt vấn đề|Mở đầu|Tổng quan|Tổng quan tài liệu|Phương pháp nghiên cứu|Phương pháp|Nội dung và phương pháp nghiên cứu|Kết quả|Kết quả và bàn luận|Bàn luận|Kết luận|Kiến nghị|Lời cảm ơn|Tài liệu tham khảo|Phụ lục)$/iu;

  let fallbackCounter = 0;
  const seenTitles = new Set<string>();
  let isInsideReferences = false;

  const falseSentenceStarters = [
    'in all cases',
    'we note that',
    'the vector',
    'for example',
    'the glue',
    'the triviaqa',
    'note that',
    'question:',
    'does bert',
    'in addition',
    'furthermore',
    'however',
    'as shown in',
    'as described in',
    'we also',
    'we find that',
  ];

  for (const p of pages) {
    const pageNum = p.pageNumber ?? p.pageIndex + 1;
    const rawContent = (p.textContent || '').normalize('NFKC');
    const lines = rawContent
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    for (const line of lines) {
      if (line.length > 90) continue;
      const numberedMatch = line.match(numberedHeadingRegex);
      const canonicalMatch = !numberedMatch
        ? line.match(canonicalHeadingRegex)
        : null;

      if (numberedMatch || canonicalMatch) {
        const num = numberedMatch ? numberedMatch[1] : undefined;
        const title = (
          numberedMatch ? numberedMatch[2] : canonicalMatch![1]
        ).trim();

        // Reject if line ends with period, comma, or colon (sentences / body text)
        if (/[.,;:]$/.test(title)) continue;

        // Reject if title is too long (sentence-like)
        const wordCount = title.split(/\s+/).filter(Boolean).length;
        if (wordCount > 10) continue;

        const lowerTitle = title.toLowerCase();
        if (falseSentenceStarters.some((prefix) => lowerTitle.startsWith(prefix))) {
          continue;
        }

        const isRef = /^(?:references|bibliography|tài liệu tham khảo)$/i.test(title);
        const isPostRefAppendix = /^(?:appendix|appendices|supplementary material|phụ lục)$/i.test(title);

        if (isInsideReferences && !isPostRefAppendix) {
          continue;
        }

        if (isRef) {
          isInsideReferences = true;
        }

        const dedupeKey = `${num || ''}:${lowerTitle}`;
        if (seenTitles.has(dedupeKey)) continue;
        seenTitles.add(dedupeKey);

        fallbackCounter++;
        const level = num ? Math.min(3, num.split('.').length) : 1;
        sections.push({
          id: `sec-${fallbackCounter}`,
          ...(num ? { num } : {}),
          title,
          level,
          page: pageNum,
          pageNumber: pageNum,
          paragraphs: [],
        });
      }
    }
  }

  return sections;
}

/**
 * High-performance, zero-dependency XMP (Extensible Metadata Platform) XML parser.
 * Complies with ISO 16684-1:2019 and Adobe PDF 1.7 Specification (Section 10.2.2).
 *
 * Scans the entire PDF buffer (via C++ `Buffer.indexOf`) for uncompressed `<x:xmpmeta>`
 * or `<rdf:RDF>` packets, and also decompresses `/FlateDecode` `/Type /Metadata` streams
 * when publisher PDFs compress their XMP stream.
 */
export class XmpParser {
  private static readonly logger = new Logger(XmpParser.name);

  private static readonly XMP_OPEN_BYTES = Buffer.from('<x:xmpmeta', 'utf-8');
  private static readonly XMP_CLOSE_BYTES = Buffer.from('</x:xmpmeta>', 'utf-8');
  private static readonly RDF_OPEN_BYTES = Buffer.from('<rdf:RDF', 'utf-8');
  private static readonly RDF_CLOSE_BYTES = Buffer.from('</rdf:RDF>', 'utf-8');
  private static readonly METADATA_TYPE_BYTES = Buffer.from('/Metadata', 'latin1');
  private static readonly STREAM_OPEN_BYTES = Buffer.from('stream', 'latin1');
  private static readonly STREAM_CLOSE_BYTES = Buffer.from('endstream', 'latin1');

  private static decodeXmlEntities(str: string): string {
    return decodeHtmlEntities(str).trim();
  }

  private static extractRawXmpPacket(buffer: Buffer): string | null {
    if (!buffer || buffer.length === 0) return null;

    // 1. Fast native C++ byte search across the entire buffer for uncompressed <x:xmpmeta>
    const xmpStart = buffer.indexOf(this.XMP_OPEN_BYTES);
    if (xmpStart !== -1) {
      const xmpEnd = buffer.indexOf(this.XMP_CLOSE_BYTES, xmpStart);
      if (xmpEnd !== -1 && xmpEnd > xmpStart && xmpEnd - xmpStart <= 524288) {
        return buffer
          .subarray(xmpStart, xmpEnd + this.XMP_CLOSE_BYTES.length)
          .toString('utf-8');
      }
    }

    // 2. Fast native byte search across the entire buffer for standalone <rdf:RDF>
    const rdfStart = buffer.indexOf(this.RDF_OPEN_BYTES);
    if (rdfStart !== -1) {
      const rdfEnd = buffer.indexOf(this.RDF_CLOSE_BYTES, rdfStart);
      if (rdfEnd !== -1 && rdfEnd > rdfStart && rdfEnd - rdfStart <= 524288) {
        return buffer
          .subarray(rdfStart, rdfEnd + this.RDF_CLOSE_BYTES.length)
          .toString('utf-8');
      }
    }

    // 3. Fallback for /FlateDecode compressed /Metadata streams in publisher/LaTeX PDFs
    let searchPos = 0;
    while (searchPos < buffer.length) {
      const metaIdx = buffer.indexOf(this.METADATA_TYPE_BYTES, searchPos);
      if (metaIdx === -1) break;
      searchPos = metaIdx + this.METADATA_TYPE_BYTES.length;

      // Inspect dictionary window around `/Metadata` (up to 512 bytes forward)
      const dictWindowEnd = Math.min(buffer.length, metaIdx + 512);
      const dictWindow = buffer.subarray(metaIdx, dictWindowEnd).toString('latin1');
      if (!/\/Subtype\s*\/XML\b|\/Type\s*\/Metadata\b/i.test(dictWindow)) {
        continue;
      }

      const streamKeywordIdx = buffer.indexOf(this.STREAM_OPEN_BYTES, metaIdx);
      if (streamKeywordIdx === -1 || streamKeywordIdx > metaIdx + 1024) {
        continue;
      }

      let dataStart = streamKeywordIdx + this.STREAM_OPEN_BYTES.length;
      if (buffer[dataStart] === 0x0d && buffer[dataStart + 1] === 0x0a) {
        dataStart += 2;
      } else if (buffer[dataStart] === 0x0a || buffer[dataStart] === 0x0d) {
        dataStart += 1;
      }

      const streamEndIdx = buffer.indexOf(this.STREAM_CLOSE_BYTES, dataStart);
      if (
        streamEndIdx === -1 ||
        streamEndIdx <= dataStart ||
        streamEndIdx - dataStart > 262144
      ) {
        continue;
      }

      let compressedSlice = buffer.subarray(dataStart, streamEndIdx);
      while (
        compressedSlice.length > 0 &&
        (compressedSlice[compressedSlice.length - 1] === 0x0a ||
          compressedSlice[compressedSlice.length - 1] === 0x0d)
      ) {
        compressedSlice = compressedSlice.subarray(0, compressedSlice.length - 1);
      }

      try {
        let decompressed: Buffer;
        const zlibOpts = { maxOutputLength: 10 * 1024 * 1024 }; // 10MB Zip Bomb protection
        try {
          decompressed = inflateSync(compressedSlice, zlibOpts);
        } catch {
          decompressed = inflateRawSync(compressedSlice, zlibOpts);
        }
        const xmlText = decompressed.toString('utf-8');
        if (xmlText.includes('<x:xmpmeta') || xmlText.includes('<rdf:RDF')) {
          return xmlText;
        }
      } catch {
        // Not a valid zlib/deflate metadata stream; continue scanning
      }
    }

    return null;
  }

  public static parse(buffer: Buffer):
    | (RawXmpMetadata & {
        volume?: string;
        issue?: string;
        pages?: string;
        startingPage?: string;
        endingPage?: string;
        issn?: string;
        isbn?: string;
      })
    | null {
    const rawPacket = this.extractRawXmpPacket(buffer);
    if (!rawPacket) return null;

    try {
      const metadata: RawXmpMetadata & {
        volume?: string;
        issue?: string;
        pages?: string;
        startingPage?: string;
        endingPage?: string;
        issn?: string;
        isbn?: string;
      } = { rawPacket };

      const stripDoiPrefix = (val: string) =>
        val
          .trim()
          .replace(/^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i, '')
          .trim();

      const prismDoi =
        rawPacket.match(/<prism:doi>([^<]+)<\/prism:doi>/i)?.[1] ||
        rawPacket.match(/\bprism:doi=["']([^"']+)["']/i)?.[1];
      const dcIdentifierFlat =
        rawPacket.match(/<dc:identifier>([^<]+)<\/dc:identifier>/i)?.[1] ||
        rawPacket.match(/\bdc:identifier=["']([^"']+)["']/i)?.[1];
      let dcIdentifierBagDoi: string | undefined;
      const dcIdentifierContainer = rawPacket.match(
        /<dc:identifier>([\s\S]*?)<\/dc:identifier>/i,
      )?.[1];
      if (dcIdentifierContainer) {
        const liMatches = [
          ...dcIdentifierContainer.matchAll(
            /<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/gi,
          ),
        ];
        for (const m of liMatches) {
          const candidate = stripDoiPrefix(this.decodeXmlEntities(m[1]));
          if (/^10\.\d{4,9}\/\S+$/i.test(candidate)) {
            dcIdentifierBagDoi = candidate;
            break;
          }
        }
      }

      const candidateDois = [prismDoi, dcIdentifierBagDoi, dcIdentifierFlat]
        .filter((v): v is string => Boolean(v))
        .map((v) => stripDoiPrefix(this.decodeXmlEntities(v)));
      const validDoi = candidateDois.find((d) => /^10\.\d{4,9}\/\S+$/i.test(d));
      if (validDoi) {
        metadata.doi = validDoi;
      }

      const dcTitleContainer = rawPacket.match(
        /<dc:title>([\s\S]*?)<\/dc:title>/i,
      )?.[1];
      const dcTitleLi = dcTitleContainer?.match(
        /<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/i,
      )?.[1];
      const dcTitleFlat =
        (!dcTitleLi && dcTitleContainer && !dcTitleContainer.includes('<')
          ? dcTitleContainer
          : undefined) ||
        rawPacket.match(/\bdc:title=["']([^"']+)["']/i)?.[1];
      const rawTitle = dcTitleLi || dcTitleFlat;
      if (rawTitle && rawTitle.trim().length > 3) {
        metadata.title = this.decodeXmlEntities(rawTitle.trim());
      }

      const creatorContainer = rawPacket.match(
        /<dc:creator>([\s\S]*?)<\/dc:creator>/i,
      )?.[1];
      if (creatorContainer) {
        const authorMatches = [
          ...creatorContainer.matchAll(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/gi),
        ];
        const authors = authorMatches
          .map((m) => this.decodeXmlEntities(m[1]))
          .filter((name) => name.length > 1 && !/^\d+$/.test(name));

        if (authors.length > 0) {
          metadata.authors = authors;
        }
      }

      const prismDate =
        rawPacket.match(
          /<prism:publicationDate>([^<]+)<\/prism:publicationDate>/i,
        )?.[1] ||
        rawPacket.match(/\bprism:publicationDate=["']([^"']+)["']/i)?.[1];
      const prismCoverDate =
        rawPacket.match(/<prism:coverDate>([^<]+)<\/prism:coverDate>/i)?.[1] ||
        rawPacket.match(/\bprism:coverDate=["']([^"']+)["']/i)?.[1];
      const dcDateContainer = rawPacket.match(
        /<dc:date>([\s\S]*?)<\/dc:date>/i,
      )?.[1];
      const dcDateLi = dcDateContainer?.match(
        /<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/i,
      )?.[1];
      const dcDateFlat =
        (!dcDateLi && dcDateContainer && !dcDateContainer.includes('<')
          ? dcDateContainer
          : undefined) ||
        rawPacket.match(/\bdc:date=["']([^"']+)["']/i)?.[1];
      const dcDate = dcDateLi || dcDateFlat;

      const chosenDate = prismDate || prismCoverDate || dcDate;
      if (chosenDate) {
        metadata.publicationDate = chosenDate.trim();
        const yearMatch = chosenDate.match(/(\d{4})/);
        if (yearMatch) {
          const parsedYear = parseInt(yearMatch[1], 10);
          if (
            parsedYear >= 1900 &&
            parsedYear <= new Date().getFullYear() + 2
          ) {
            metadata.year = parsedYear;
          }
        }
      }

      const publisher =
        rawPacket.match(/<prism:publisher>([^<]+)<\/prism:publisher>/i)?.[1] ||
        rawPacket.match(/<dc:publisher>([^<]+)<\/dc:publisher>/i)?.[1] ||
        rawPacket.match(/\b(?:prism|dc):publisher=["']([^"']+)["']/i)?.[1];
      if (publisher) {
        metadata.publisher = this.decodeXmlEntities(publisher.trim());
      }

      const publicationName =
        rawPacket.match(
          /<prism:publicationName>([^<]+)<\/prism:publicationName>/i,
        )?.[1] ||
        rawPacket.match(/\bprism:publicationName=["']([^"']+)["']/i)?.[1];
      if (publicationName) {
        metadata.journal = this.decodeXmlEntities(publicationName.trim());
      }

      const rawVolume =
        rawPacket.match(/<prism:volume>([^<]+)<\/prism:volume>/i)?.[1] ||
        rawPacket.match(/\bprism:volume=["']([^"']+)["']/i)?.[1];
      if (rawVolume && rawVolume.trim()) {
        metadata.volume = this.decodeXmlEntities(rawVolume.trim());
      }

      const rawIssue =
        rawPacket.match(/<prism:issue>([^<]+)<\/prism:issue>/i)?.[1] ||
        rawPacket.match(/\bprism:issue=["']([^"']+)["']/i)?.[1];
      if (rawIssue && rawIssue.trim()) {
        metadata.issue = this.decodeXmlEntities(rawIssue.trim());
      }

      const rawStartingPage =
        rawPacket.match(
          /<prism:startingPage>([^<]+)<\/prism:startingPage>/i,
        )?.[1] ||
        rawPacket.match(/\bprism:startingPage=["']([^"']+)["']/i)?.[1];
      const rawEndingPage =
        rawPacket.match(
          /<prism:endingPage>([^<]+)<\/prism:endingPage>/i,
        )?.[1] || rawPacket.match(/\bprism:endingPage=["']([^"']+)["']/i)?.[1];
      const rawPageRange =
        rawPacket.match(/<prism:pageRange>([^<]+)<\/prism:pageRange>/i)?.[1] ||
        rawPacket.match(/\bprism:pageRange=["']([^"']+)["']/i)?.[1];
      if (rawStartingPage && rawStartingPage.trim()) {
        metadata.startingPage = this.decodeXmlEntities(rawStartingPage.trim());
      }
      if (rawEndingPage && rawEndingPage.trim()) {
        metadata.endingPage = this.decodeXmlEntities(rawEndingPage.trim());
      }
      if (metadata.startingPage && metadata.endingPage) {
        metadata.pages = `${metadata.startingPage}-${metadata.endingPage}`;
      } else if (rawPageRange && rawPageRange.trim()) {
        metadata.pages = this.decodeXmlEntities(rawPageRange.trim());
      } else if (metadata.startingPage) {
        metadata.pages = metadata.startingPage;
      }

      const rawIssn =
        rawPacket.match(/<prism:issn>([^<]+)<\/prism:issn>/i)?.[1] ||
        rawPacket.match(/\bprism:issn=["']([^"']+)["']/i)?.[1] ||
        rawPacket.match(/<prism:eIssn>([^<]+)<\/prism:eIssn>/i)?.[1] ||
        rawPacket.match(/\bprism:eIssn=["']([^"']+)["']/i)?.[1];
      if (rawIssn && rawIssn.trim()) {
        metadata.issn = this.decodeXmlEntities(rawIssn.trim());
      }

      const rawIsbn =
        rawPacket.match(/<prism:isbn>([^<]+)<\/prism:isbn>/i)?.[1] ||
        rawPacket.match(/\bprism:isbn=["']([^"']+)["']/i)?.[1];
      if (rawIsbn && rawIsbn.trim()) {
        metadata.isbn = this.decodeXmlEntities(rawIsbn.trim());
      }

      const descriptionContainer = rawPacket.match(
        /<dc:description>([\s\S]*?)<\/dc:description>/i,
      )?.[1];
      const descriptionLi = descriptionContainer?.match(
        /<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/i,
      )?.[1];
      const descriptionFlat =
        (!descriptionLi &&
        descriptionContainer &&
        !descriptionContainer.includes('<')
          ? descriptionContainer
          : undefined) ||
        rawPacket.match(/\bdc:description=["']([^"']+)["']/i)?.[1];
      const rawDesc = descriptionLi || descriptionFlat;
      if (rawDesc && rawDesc.trim().length > 20) {
        metadata.description = this.decodeXmlEntities(rawDesc.trim());
      }

      const subjectContainer = rawPacket.match(
        /<dc:subject>([\s\S]*?)<\/dc:subject>/i,
      )?.[1];
      if (subjectContainer) {
        const keywordMatches = [
          ...subjectContainer.matchAll(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/gi),
        ];
        const rawSubjects = keywordMatches
          .map((m) => this.decodeXmlEntities(m[1]))
          .filter(Boolean);
        const keywords = normalizeTags(rawSubjects);
        if (keywords.length > 0) {
          metadata.keywords = keywords;
        }
      }

      return metadata;
    } catch (err: unknown) {
      this.logger.debug(
        `Failed to parse XMP packet: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
