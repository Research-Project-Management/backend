import { Injectable } from '@nestjs/common';
import { cleanAbstractText } from '@/modules/library/core';
import { normalizeAcademicTags } from '@/modules/library/core/domain/tag.domain';
import type { ExtractedPdfMetadata } from './pdf.provider';

@Injectable()
export class PdfTextMetadataExtractor {
  static readonly TEXT_SCAN_LIMIT = 50000;

  extractFromText(text: string): string | null {
    if (!text) return null;

    const scannedText = text.slice(0, PdfTextMetadataExtractor.TEXT_SCAN_LIMIT);
    const joinedText = scannedText
      .replace(/(10\.\d{4,9})\s*\/\s*/g, '$1/')
      .replace(/(10\.\d{4,9}\/)\s+/g, '$1');
    const doiMatches =
      joinedText.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/g) ?? [];

    for (const match of doiMatches) {
      const doi = match.replace(/[.,;)\]]+$/, '');
      if (/n{4,}/i.test(doi)) continue;
      return doi;
    }

    const arxivMatch = scannedText.match(
      /(?:arxiv:?\s*|\barxiv\.org\/(?:abs|pdf)\/|\b)([0-2][0-9]{3}\.[0-9]{4,5}(?:v[0-9]+)?|[a-zA-Z-]+(?:\.[a-zA-Z-]+)?\/\d{7}(?:v\d+)?)\b/i,
    );
    return arxivMatch?.[1] ? `10.48550/arXiv.${arxivMatch[1]}` : null;
  }

  extractMetadataFromText(text: string): ExtractedPdfMetadata {
    const scannedText = text.slice(0, PdfTextMetadataExtractor.TEXT_SCAN_LIMIT);
    const metadata: ExtractedPdfMetadata = {};
    const doi = this.extractFromText(
      scannedText
        .replace(/(10\.\d{4,9})\s*\/\s*/g, '$1/')
        .replace(/(10\.\d{4,9}\/)\s*\n\s*/g, '$1'),
    );
    if (doi) metadata.doi = doi;

    const arxivMatch = scannedText.match(
      /(?:arxiv[:\s._/-]+)([0-2]\d{3}\.\d{4,5}(?:v\d+)?|[a-zA-Z-]+(?:\.[a-zA-Z-]+)?\/\d{7}(?:v\d+)?)(?:\s*\[([a-zA-Z-]+(?:\.[a-zA-Z-]+)?)\])?/i,
    );
    if (arxivMatch?.[1]) {
      metadata.arxivId = arxivMatch[1];
      if (arxivMatch[2]) {
        metadata.primaryCategory = arxivMatch[2];
      }
    } else {
      const standalone = scannedText
        .slice(0, 2000)
        .match(/\b([0-2][0-9]{3}\.[0-9]{4,5}(?:v[0-9]+)?)\b/);
      if (standalone?.[1]) metadata.arxivId = standalone[1];
    }

    const isbnMatch = scannedText.match(
      /(?:ISBN(?:-1[03])?:?\s*)([0-9Xx\s-]{10,20})/i,
    );
    if (isbnMatch) {
      const cleanIsbn = isbnMatch[1].replace(/[-\s]/g, '').trim();
      if (cleanIsbn.length === 10 || cleanIsbn.length === 13) {
        metadata.isbn = cleanIsbn;
      }
    }

    const issnMatch = scannedText.match(/\bISSN\s*:?\s*(\d{4}-\d{3}[\dXx])\b/i);
    if (issnMatch?.[1]) {
      metadata.issn = issnMatch[1].toUpperCase();
    }

    const pmidMatch = scannedText.match(/\bPMID\s*:?\s*(\d{5,9})\b/i);
    if (pmidMatch?.[1]) {
      metadata.pmid = pmidMatch[1];
    }

    const pubMatch = scannedText.match(
      /\b(Cambridge University Press|Springer(?:-Verlag)?|MIT Press|Prentice Hall|Stanford University(?: Press)?|Oxford University Press|IEEE|ACM|Elsevier|Wiley)\b/i,
    );
    if (pubMatch) {
      metadata.publisher = pubMatch[1].trim();
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
      /(?:^|\n)\s*(?:Index\s+Terms|Keywords|Key\s*words)\s*[—:\-–]+\s*([^\n.]+)/i,
    );
    if (keywordsMatch?.[1]) {
      const rawTokens = keywordsMatch[1]
        .split(/[,;•|]/)
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
        .replace(/\b([A-Z])\s+([A-Z]{2,})\b/g, '$1$2')
        .replace(/\b([B-HJ-Z])\s+([A-Z])\b/g, '$1$2')
        .replace(/\b([A-Za-z0-9]+)\s+-\s+([A-Za-z0-9]+)\b/g, '$1-$2')
        .replace(/\b([A-Za-z])\s+([A-Za-z])\b/g, '$1$2')
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
          if (authorLine.includes(',')) {
            const rawAuthorNames = authorLine
              .replace(/[*†‡§\d]/g, '')
              .split(/[,;]|\band\b/i);
            for (const rawAuthorName of rawAuthorNames) {
              const cleanName = rawAuthorName.replace(/\s+/g, ' ').trim();
              const nameParts = cleanName.split(' ');
              if (
                nameParts.length >= 2 &&
                nameParts.length <= 4 &&
                nameParts.every((partItem) => /^[A-ZÀ-Ỹ]/.test(partItem))
              ) {
                parsedAuthors.push(cleanName);
              }
            }
          } else {
            const nameWords = authorLine
              .replace(/[*†‡§\d]/g, '')
              .split(/\s+/)
              .filter((wordItem) => /^[A-ZÀ-Ỹ]/.test(wordItem));
            for (
              let wordIndex = 0;
              wordIndex < nameWords.length - 1;
              wordIndex += 2
            ) {
              parsedAuthors.push(
                `${nameWords[wordIndex]} ${nameWords[wordIndex + 1]}`,
              );
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
}
