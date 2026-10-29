import { Injectable } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import {
  cleanAbstractText,
  AcademicRegexCatalog,
  splitAuthorString,
  cleanAuthorName,
  splitConcatenatedAuthors,
} from '@/modules/library/core';
import { normalizeAcademicTags } from '@/modules/library/core/domain/tag.domain';
import { TrustedExtractionService } from '@/modules/library/extraction/services/trusted-extraction.service';
import type { ExtractedPdfMetadata } from './pdf.provider';

@Injectable()
export class PdfTextMetadataExtractor {
  static readonly TEXT_SCAN_LIMIT = 50000;

  private findReferencesHeadingIndex(text: string): number {
    const pattern =
      /\n[^\S\r\n]*(?:(?:\d+\.?|[IVX]+\.?)\s+)?(?:references|bibliography|literature\s+cited)\b([^\r\n]*)/gi;
    for (const match of text.matchAll(pattern)) {
      const idx = match.index ?? -1;
      if (idx === -1) continue;
      const trailing = (match[1] || '').trim();
      // Ignore TOC lines like "References .... 42" or "References 42"
      if (trailing !== '' && trailing !== ':') {
        continue;
      }
      if (idx < 1000) {
        const afterMatch = text.slice(idx + match[0].length, idx + match[0].length + 80);
        if (/^(?:\r?\n)?\s*(?:[.\u2026·]{2,}\s*\d+|\d{1,4}\s*(?:\r?\n|$))/.test(afterMatch)) {
          continue;
        }
      }
      return idx;
    }
    return -1;
  }

  extractFromText(text: string): string | null {
    if (!text) return null;

    // Restrict identifier scan to front-matter (first 4,000 chars, before References/Bibliography)
    // so cited DOIs and arXiv IDs in the body or bibliography are never mistaken for the paper's own ID.
    const refIdx = this.findReferencesHeadingIndex(text);
    const frontLimit = refIdx !== -1 ? Math.min(4000, refIdx) : 4000;
    const frontMatter = text
      .slice(0, frontLimit)
      .replace(/(10\.\d{4,9})\s*\/\s*/g, '$1/')
      .replace(/(10\.\d{4,9}\/)\s+/g, '$1');

    const catalogScan = AcademicRegexCatalog.scan(frontMatter);
    if (catalogScan.doi) {
      return catalogScan.doi;
    }
    if (catalogScan.arxivId) {
      return `10.48550/arXiv.${catalogScan.arxivId}`;
    }

    const arxivMatch = frontMatter.match(
      /(?:arxiv:\s*|\barxiv\.org\/(?:abs|pdf)\/)([0-2][0-9]{3}\.[0-9]{4,5}(?:v[0-9]+)?|[a-zA-Z-]+(?:\.[a-zA-Z-]+)?\/\d{7}(?:v\d+)?)\b/i,
    );
    return arxivMatch?.[1] ? `10.48550/arXiv.${arxivMatch[1]}` : null;
  }

  extractMetadataFromText(text: string): ExtractedPdfMetadata {
    const scannedText = text.slice(0, PdfTextMetadataExtractor.TEXT_SCAN_LIMIT);
    const refIdx = this.findReferencesHeadingIndex(scannedText);
    const preRefText = refIdx !== -1 ? scannedText.slice(0, refIdx) : scannedText;
    const frontMatter = preRefText.slice(0, 4000);
    const normalizedFrontMatter = frontMatter
      .replace(/(10\.\d{4,9})\s*\/\s*/g, '$1/')
      .replace(/(10\.\d{4,9}\/)\s*\n\s*/g, '$1');
    const catalogScan = AcademicRegexCatalog.scan(normalizedFrontMatter);
    const metadata: ExtractedPdfMetadata = {};
    const doi = catalogScan.doi ?? this.extractFromText(normalizedFrontMatter);
    if (doi) metadata.doi = doi;

    // The arXiv margin watermark ("arXiv:1706.03762v7 [cs.CL] 2 Aug 2023") is emitted by PDF text
    // layers after the page body, i.e. outside the 4,000-char front window. Its bracketed subject
    // class is unique to the paper's own stamp (citations never carry one), so scan the whole
    // pre-References text for that exact shape first.
    const stampMatch = preRefText.match(
      /arxiv:\s*([0-2]\d{3}\.\d{4,5}(?:v\d+)?|[a-zA-Z-]+(?:\.[a-zA-Z-]+)?\/\d{7}(?:v\d+)?)\s*\[([a-zA-Z-]+(?:\.[a-zA-Z-]+)?)\]/i,
    );
    if (stampMatch?.[1]) {
      metadata.arxivId = stampMatch[1];
      if (stampMatch[2]) {
        metadata.primaryCategory = stampMatch[2];
      }
    } else if (catalogScan.arxivId) {
      metadata.arxivId = catalogScan.arxivId;
      if (catalogScan.primaryCategory) {
        metadata.primaryCategory = catalogScan.primaryCategory;
      }
    } else {
      const arxivMatch = frontMatter.match(
        /(?:arxiv[:\s._/-]+)([0-2]\d{3}\.\d{4,5}(?:v\d+)?|[a-zA-Z-]+(?:\.[a-zA-Z-]+)?\/\d{7}(?:v\d+)?)(?:\s*\[([a-zA-Z-]+(?:\.[a-zA-Z-]+)?)\])?/i,
      );
      if (arxivMatch?.[1]) {
        metadata.arxivId = arxivMatch[1];
        if (arxivMatch[2]) {
          metadata.primaryCategory = arxivMatch[2];
        }
      }
    }

    if (catalogScan.isbn) {
      metadata.isbn = catalogScan.isbn;
    }

    if (catalogScan.issn) {
      metadata.issn = catalogScan.issn.toUpperCase();
    }

    if (catalogScan.pmid) {
      metadata.pmid = catalogScan.pmid;
    } else {
      const pmidMatch = frontMatter.match(/\bPMID\s*:?\s*(\d{5,9})\b/i);
      if (pmidMatch?.[1]) {
        metadata.pmid = pmidMatch[1];
      }
    }

    if (catalogScan.publisher) {
      metadata.publisher = catalogScan.publisher;
    } else {
      const pubMatch = scannedText.match(
        AcademicRegexCatalog.PUBLISHER_IMPRINT_PATTERN,
      );
      if (pubMatch) {
        metadata.publisher = (pubMatch[1] || pubMatch[0]).trim();
      }
    }

    const abstractMatch = scannedText.match(
      /(?:^|\n)\s*(?:Abstract|ABSTRACT|Summary|Résumé)[—:\-\s.]*\s*([\s\S]*?)(?=(?:\n\s*(?:Index Terms|Keywords|Key\s*words|1\.?\s+[A-Z]|I\.?\s+[A-Z]|INTRODUCTION|Contents|Background|1\b|I\b))|(?:\r?\n\s*\r?\n\s*(?:[A-Z0-9\s]{3,30}\n|1\.|\bI\b))|$)/i,
    );
    if (abstractMatch?.[1]) {
      let candidate = abstractMatch[1].trim();
      const doubleBreakIdx = candidate.search(
        /\r?\n\s*\r?\n\s*(?:[0-9IVX]+\b|[A-Z\s]{4,}\b)/,
      );
      if (doubleBreakIdx > 50) {
        candidate = candidate.slice(0, doubleBreakIdx);
      } else if (candidate.length > 1800) {
        const sentenceEnd = candidate.slice(0, 1500).lastIndexOf('.');
        if (sentenceEnd > 200) {
          candidate = candidate.slice(0, sentenceEnd + 1);
        } else {
          candidate = candidate.slice(0, 1500);
        }
      }
      const cleanAbstract = cleanAbstractText(candidate);
      if (cleanAbstract && cleanAbstract.length > 15) {
        metadata.abstract = cleanAbstract;
      }
    }

    const keywordsMatch = scannedText.match(
      AcademicRegexCatalog.KEYWORDS_PATTERN,
    );
    if (keywordsMatch?.[1]) {
      const rawTokens = keywordsMatch[1]
        .split(/[,;•|\n]/)
        .map((k) => k.trim())
        .filter((k) => k.length > 1 && k.split(/\s+/).length <= 7);
      const normalized = normalizeAcademicTags(rawTokens);
      if (normalized.length > 0) {
        metadata.keywords = normalized;
      }
    }

    const lines = scannedText
      .split('\n')
      .map((lineItem) => lineItem.trim())
      .filter(Boolean);

    let abstractIndex = -1;
    for (
      let lineIndex = 0;
      lineIndex < Math.min(lines.length, 60);
      lineIndex++
    ) {
      if (/^abstract\b/i.test(lines[lineIndex])) {
        abstractIndex = lineIndex;
        break;
      }
    }

    const headerLines =
      abstractIndex !== -1 ? lines.slice(0, abstractIndex) : lines.slice(0, 25);
    const cleanLines = headerLines.filter((lineItem) => {
      if (
        /^(arxiv[:\s._/-]*\d|https?:\/\/|\d+$|submitted to|accepted (as|at)|published as|proceedings of|ieee|acm|springer|elsevier|under review|provided proper)/i.test(
          lineItem,
        )
      )
        return false;
      if (
        /reproduce the tables and figures|permission to|copyright|all rights reserved|doi:\s*10\.|scholarly works/i.test(
          lineItem,
        )
      )
        return false;
      if (/^\d+\s*\|\s*[a-z]/i.test(lineItem)) return false;
      return true;
    });

    if (cleanLines.length > 0) {
      const titleLines: string[] = [];
      let authorStartIndex = -1;

      for (let lineIndex = 0; lineIndex < cleanLines.length; lineIndex++) {
        const currentLine = cleanLines[lineIndex];
        if (
          /@|univ|institute|department|college|laboratory|school|hospital|center/i.test(
            currentLine,
          )
        ) {
          if (authorStartIndex === -1) authorStartIndex = lineIndex;
          break;
        }
        const hasCommaOrAnd = /(?:,|\band\b)/i.test(currentLine);
        const wordsInLine = currentLine.split(/\s+/);
        const looksLikeMultipleNames =
          wordsInLine.length >= 4 &&
          wordsInLine.every(
            (wordItem) =>
              /^[A-ZÀ-Ỹ]/.test(wordItem) || /[*†‡§\d]/.test(wordItem),
          );

        if (
          titleLines.length > 0 &&
          (hasCommaOrAnd || looksLikeMultipleNames)
        ) {
          authorStartIndex = lineIndex;
          break;
        }

        titleLines.push(currentLine);
        const nextLine = cleanLines[lineIndex + 1];
        const nextIsContinuation = Boolean(
          nextLine &&
          /^(for|by|and|with|in|on|using|via|under|towards|from|to|of)\b/i.test(
            nextLine.trim(),
          ),
        );
        const endsWithHyphen = currentLine.trim().endsWith('-');
        if (
          !endsWithHyphen &&
          !nextIsContinuation &&
          (currentLine.length >= 40 || titleLines.length >= 2)
        ) {
          authorStartIndex = lineIndex + 1;
          break;
        }
      }

      const rawTitle = titleLines
        .filter((l, i, arr) => arr.indexOf(l) === i)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const candidateTitle = rawTitle
        .replace(
          /\b([A-Za-z])(?:\s+([A-Za-z])){2,}\b/g,
          (match) =>
            match
              .split(/\s{2,}/)
              .map((word) => word.replace(/\s+/g, ''))
              .join(' '),
        )
        .replace(/\b([A-Za-z0-9]+)\s+-\s+([A-Za-z0-9]+)\b/g, '$1-$2')
        .replace(/-\s+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (candidateTitle.length > 5 && candidateTitle.length < 250) {
        metadata.title = candidateTitle;
      }

      const parsedAuthors: string[] = [];
      if (authorStartIndex !== -1 && authorStartIndex < cleanLines.length) {
        for (
          let lineIndex = authorStartIndex;
          lineIndex < cleanLines.length;
          lineIndex++
        ) {
          const authorLine = cleanLines[lineIndex];
          if (
            /^(for|by|and|with|using|towards|under)\s+[A-Z]/i.test(
              authorLine.trim(),
            )
          ) {
            continue;
          }
          if (
            /@|univ|institute|department|college|laboratory|school|hospital|center|research|microsoft|google/i.test(
              authorLine,
            )
          ) {
            continue;
          }
          const rawCandidates = splitAuthorString(authorLine).flatMap((name) =>
            splitConcatenatedAuthors(name, 4),
          );
          for (const candidate of rawCandidates) {
            const cleaned = cleanAuthorName(candidate);
            if (cleaned && cleaned.split(/\s+/).length >= 2) {
              parsedAuthors.push(cleaned);
            }
          }
        }
      }

      if (parsedAuthors.length > 0) {
        metadata.authors = parsedAuthors;
      }
    }

    return metadata;
  }

  async extractMetadataFromBufferAsync(
    buffer: Buffer,
  ): Promise<ExtractedPdfMetadata> {
    if (!buffer || buffer.length === 0) {
      return {};
    }

    const fallback = this.extractMetadataFromBuffer(buffer);
    try {
      const pdfDoc = await PDFDocument.load(buffer, {
        ignoreEncryption: true,
        updateMetadata: false,
      });
      const pdfLibMeta: ExtractedPdfMetadata = { ...fallback };

      const rawTitle = pdfDoc.getTitle();
      if (rawTitle) {
        const cleanTitle = this.decodePdfInfoString(rawTitle);
        if (
          cleanTitle.length > 3 &&
          !cleanTitle.toLowerCase().endsWith('.pdf') &&
          !TrustedExtractionService.isBogusTitle(cleanTitle)
        ) {
          pdfLibMeta.title = cleanTitle;
        }
      }

      const rawAuthor = pdfDoc.getAuthor();
      if (rawAuthor) {
        const cleanAuthorStr = this.decodePdfInfoString(rawAuthor);
        if (
          cleanAuthorStr.length > 1 &&
          !/^(administrator|user|owner|unknown)$/i.test(cleanAuthorStr)
        ) {
          const authors = splitAuthorString(cleanAuthorStr)
            .map((a) => cleanAuthorName(a))
            .filter(Boolean);
          pdfLibMeta.authors =
            authors.length > 0 ? authors : [cleanAuthorStr];
        }
      }

      const rawSubject = pdfDoc.getSubject();
      if (rawSubject) {
        const cleanSubject = this.decodePdfInfoString(rawSubject);
        if (cleanSubject.length > 15 && !pdfLibMeta.abstract) {
          pdfLibMeta.abstract = cleanAbstractText(cleanSubject) || cleanSubject;
        }
      }

      const rawKeywords = pdfDoc.getKeywords();
      if (rawKeywords) {
        const cleanKeywordsStr = this.decodePdfInfoString(rawKeywords);
        const tokens = cleanKeywordsStr
          .split(/[,;•|]/)
          .map((k) => k.trim())
          .filter((k) => k.length > 1 && k.split(/\s+/).length <= 7);
        const normalizedKw = normalizeAcademicTags(tokens);
        if (normalizedKw.length > 0) {
          pdfLibMeta.keywords = normalizedKw;
        }
      }

      try {
        const creationDate = pdfDoc.getCreationDate();
        if (creationDate instanceof Date && !isNaN(creationDate.getTime())) {
          const year = creationDate.getUTCFullYear();
          if (year >= 1900 && year <= new Date().getFullYear() + 2) {
            pdfLibMeta.year = year;
          }
        }
      } catch {
        // Ignore malformed PDF creation date
      }

      return pdfLibMeta;
    } catch {
      return fallback;
    }
  }

  extractMetadataFromBuffer(buffer: Buffer): ExtractedPdfMetadata {
    if (!buffer || buffer.length === 0) {
      return {};
    }

    try {
      const rawHeaderStream = buffer.subarray(0, 32768).toString('latin1');
      const extractedMetadataResult: ExtractedPdfMetadata = {};

      const doiMatchResult = rawHeaderStream.match(
        /10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/,
      );
      if (doiMatchResult) {
        extractedMetadataResult.doi = doiMatchResult[0].replace(
          /[.,;)\]]+$/,
          '',
        );
      }

      const arxivMatchResult = rawHeaderStream.match(
        /arXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?|[a-zA-Z-]+(?:\.[a-zA-Z-]+)?\/\d{7}(?:v\d+)?)(?:\s*\[([a-zA-Z-]+(?:\.[a-zA-Z-]+)?)\])?/i,
      );
      if (arxivMatchResult) {
        extractedMetadataResult.arxivId = arxivMatchResult[1];
        if (arxivMatchResult[2]) {
          extractedMetadataResult.primaryCategory = arxivMatchResult[2];
        }
      }

      const decodedTitle = this.extractPdfLiteralString(
        rawHeaderStream,
        'Title',
      );
      if (decodedTitle) {
        extractedMetadataResult.title = decodedTitle;
      }

      const decodedAuthor = this.extractPdfLiteralString(
        rawHeaderStream,
        'Author',
      );
      if (decodedAuthor) {
        const splitAuthors = splitAuthorString(decodedAuthor)
          .map((a) => cleanAuthorName(a))
          .filter(Boolean);
        extractedMetadataResult.authors =
          splitAuthors.length > 0 ? splitAuthors : [decodedAuthor];
      }

      const decodedSubject = this.extractPdfLiteralString(
        rawHeaderStream,
        'Subject',
      );
      if (decodedSubject && decodedSubject.length > 15) {
        extractedMetadataResult.abstract =
          cleanAbstractText(decodedSubject) || decodedSubject;
      }

      const decodedKeywords = this.extractPdfLiteralString(
        rawHeaderStream,
        'Keywords',
      );
      if (decodedKeywords) {
        const tokens = decodedKeywords
          .split(/[,;•|]/)
          .map((k) => k.trim())
          .filter((k) => k.length > 1 && k.split(/\s+/).length <= 7);
        const normalizedKw = normalizeAcademicTags(tokens);
        if (normalizedKw.length > 0) {
          extractedMetadataResult.keywords = normalizedKw;
        }
      }

      const dateMatchResult = rawHeaderStream.match(
        /\/CreationDate\s*\(D:(\d{4})/,
      );
      if (dateMatchResult && dateMatchResult[1]) {
        extractedMetadataResult.year = parseInt(dateMatchResult[1], 10);
      }

      return extractedMetadataResult;
    } catch {
      return {};
    }
  }

  private extractPdfLiteralString(
    stream: string,
    key: string,
  ): string | undefined {
    const keyRe = new RegExp(`\\/${key}\\s*\\(`, 'i');
    const match = keyRe.exec(stream);
    if (!match) return undefined;

    let idx = match.index + match[0].length;
    let depth = 1;
    let raw = '';

    while (idx < stream.length && depth > 0) {
      const ch = stream[idx];
      if (ch === '\\' && idx + 1 < stream.length) {
        const next = stream[idx + 1];
        if (next === '(' || next === ')' || next === '\\') {
          raw += next;
          idx += 2;
          continue;
        }
        if (next === 'n' || next === 'r' || next === 't') {
          raw += ' ';
          idx += 2;
          continue;
        }
        if (/[0-7]/.test(next)) {
          const octalMatch = stream.slice(idx + 1, idx + 4).match(/^[0-7]{1,3}/);
          if (octalMatch) {
            raw += String.fromCharCode(parseInt(octalMatch[0], 8));
            idx += 1 + octalMatch[0].length;
            continue;
          }
        }
        raw += next;
        idx += 2;
        continue;
      }
      if (ch === '(') {
        depth++;
        raw += ch;
      } else if (ch === ')') {
        depth--;
        if (depth > 0) raw += ch;
      } else {
        raw += ch;
      }
      idx++;
    }

    return this.decodePdfInfoString(raw);
  }

  private decodePdfInfoString(raw: string): string {
    if (!raw) return '';
    let str = raw;

    if (
      (str.charCodeAt(0) === 0xfe && str.charCodeAt(1) === 0xff) ||
      str.startsWith('þÿ')
    ) {
      const body = str.slice(2);
      if (body.includes('\x00') || body.length % 2 === 0) {
        let utf16 = '';
        for (let i = 0; i + 1 < body.length; i += 2) {
          const code = (body.charCodeAt(i) << 8) | body.charCodeAt(i + 1);
          if (code !== 0) utf16 += String.fromCharCode(code);
        }
        str = utf16.trim() || body.replace(/\x00/g, '');
      } else {
        str = body.replace(/\x00/g, '');
      }
    } else if (str.charCodeAt(0) === 0xff && str.charCodeAt(1) === 0xfe) {
      const body = str.slice(2);
      let utf16le = '';
      for (let i = 0; i + 1 < body.length; i += 2) {
        const code = body.charCodeAt(i) | (body.charCodeAt(i + 1) << 8);
        if (code !== 0) utf16le += String.fromCharCode(code);
      }
      str = utf16le.trim() || body.replace(/\x00/g, '');
    }

    return str
      .replace(/^\uFEFF/, '')
      .replace(/^þÿ/, '')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\')
      .replace(/\x00/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
