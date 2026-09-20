import { Injectable, Logger } from '@nestjs/common';
import {
  ExtractedPdfDocument,
  ExtractedPdfMetadata,
} from '../../../library/reader/infrastructure/providers/pdf.provider';

export interface SemanticChunk {
  chunkIndex: number;
  section: string;
  pageNumber?: number;
  content: string;
  headerAttribution: string;
  fullChunkText: string;
  characterCount: number;
}

export interface ChunkingOptions {
  maxChunkSize?: number; // default: 1200 chars
  overlapSize?: number; // default: 150 chars
  title?: string;
  authors?: string[];
  doi?: string;
  year?: number;
}

const SCIENTIFIC_SECTION_PATTERNS = [
  /^(abstract|summary)/i,
  /^(1\.?\s*)?(introduction|background)/i,
  /^(2\.?\s*)?(related\s*work|literature\s*review|prior\s*art)/i,
  /^(3\.?\s*)?(methodology|method|methods|proposed\s*approach|system\s*design|architecture|model)/i,
  /^(4\.?\s*)?(experiments|experimental\s*setup|evaluation|results|findings)/i,
  /^(5\.?\s*)?(discussion|analysis)/i,
  /^(6\.?\s*)?(conclusion|concluding\s*remarks|future\s*work)/i,
  /^(references|bibliography)/i,
];

@Injectable()
export class ScientificChunkingService {
  private readonly logger = new Logger(ScientificChunkingService.name);

  /**
   * Chunks an extracted academic PDF document into semantic, section-aware chunks.
   */
  chunkPdfDocument(
    doc: ExtractedPdfDocument,
    options?: ChunkingOptions,
  ): SemanticChunk[] {
    const maxChunkSize = options?.maxChunkSize ?? 1200;
    const overlapSize = options?.overlapSize ?? 150;
    const title =
      options?.title || doc.metadata.title || 'Untitled Research Document';
    const authors = options?.authors || doc.metadata.authors || [];
    const authorsStr =
      authors.length > 0
        ? authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : '')
        : 'Unknown Authors';
    const yearStr =
      options?.year || doc.metadata.year
        ? ` (${options?.year || doc.metadata.year})`
        : '';

    const chunks: SemanticChunk[] = [];
    let chunkCounter = 0;

    // 1. If GROBID extracted structured sections, leverage those directly
    if (doc.sections && doc.sections.length > 0) {
      for (const section of doc.sections) {
        const sectionTitle = section.title || 'Section';
        const sectionText = (section.paragraphs || []).join('\n\n');
        if (!sectionText.trim()) continue;

        const subChunks = this.splitTextIntoWindows(
          sectionText,
          maxChunkSize,
          overlapSize,
        );
        for (const sub of subChunks) {
          const header = `[Document: "${title}"${yearStr} | Section: "${sectionTitle}" | Authors: ${authorsStr} | Page: ${section.page ?? 1}]`;
          const fullText = `${header}\n\n${sub}`;
          chunks.push({
            chunkIndex: chunkCounter++,
            section: sectionTitle,
            content: sub,
            headerAttribution: header,
            fullChunkText: fullText,
            characterCount: fullText.length,
          });
        }
      }
      return chunks;
    }

    // 2. Otherwise, chunk per page while detecting section headers
    let currentSection = 'Introduction';
    for (const page of doc.pages) {
      const pageText = page.textContent;
      if (!pageText || pageText.trim().length === 0) continue;

      const lines = pageText.split('\n');
      let currentSectionBuffer: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        const detectedSection = this.detectSectionHeader(trimmed);

        if (detectedSection && currentSectionBuffer.length > 0) {
          // Flush previous section buffer
          const bufferText = currentSectionBuffer.join('\n').trim();
          if (bufferText.length > 0) {
            const pageChunks = this.splitTextIntoWindows(
              bufferText,
              maxChunkSize,
              overlapSize,
            );
            for (const c of pageChunks) {
              const header = `[Document: "${title}"${yearStr} | Section: "${currentSection}" | Authors: ${authorsStr} | Page: ${page.pageIndex + 1}]`;
              const fullText = `${header}\n\n${c}`;
              chunks.push({
                chunkIndex: chunkCounter++,
                section: currentSection,
                pageNumber: page.pageIndex + 1,
                content: c,
                headerAttribution: header,
                fullChunkText: fullText,
                characterCount: fullText.length,
              });
            }
          }
          currentSectionBuffer = [];
          currentSection = detectedSection;
        }

        currentSectionBuffer.push(line);
      }

      // Flush remaining page text
      if (currentSectionBuffer.length > 0) {
        const bufferText = currentSectionBuffer.join('\n').trim();
        if (bufferText.length > 0) {
          const pageChunks = this.splitTextIntoWindows(
            bufferText,
            maxChunkSize,
            overlapSize,
          );
          for (const c of pageChunks) {
            const header = `[Document: "${title}"${yearStr} | Section: "${currentSection}" | Authors: ${authorsStr} | Page: ${page.pageIndex + 1}]`;
            const fullText = `${header}\n\n${c}`;
            chunks.push({
              chunkIndex: chunkCounter++,
              section: currentSection,
              pageNumber: page.pageIndex + 1,
              content: c,
              headerAttribution: header,
              fullChunkText: fullText,
              characterCount: fullText.length,
            });
          }
        }
      }
    }

    // Fallback if no page chunks generated
    if (chunks.length === 0 && doc.metadata.rawText) {
      const textChunks = this.splitTextIntoWindows(
        doc.metadata.rawText,
        maxChunkSize,
        overlapSize,
      );
      for (const c of textChunks) {
        const header = `[Document: "${title}"${yearStr} | Section: "General" | Authors: ${authorsStr}]`;
        const fullText = `${header}\n\n${c}`;
        chunks.push({
          chunkIndex: chunkCounter++,
          section: 'General',
          content: c,
          headerAttribution: header,
          fullChunkText: fullText,
          characterCount: fullText.length,
        });
      }
    }

    this.logger.debug(
      `Chunked document "${title}": produced ${chunks.length} semantic chunks across ${doc.pages.length} pages.`,
    );

    return chunks;
  }

  /**
   * Detects if a text line matches an academic section heading.
   */
  private detectSectionHeader(line: string): string | null {
    if (line.length < 3 || line.length > 80) return null;
    for (const pattern of SCIENTIFIC_SECTION_PATTERNS) {
      if (pattern.test(line)) {
        return line.replace(/^[\d.]+\s*/, '').trim();
      }
    }
    return null;
  }

  /**
   * Splits a string of text into sliding windows with overlap.
   */
  private splitTextIntoWindows(
    text: string,
    maxSize: number,
    overlap: number,
  ): string[] {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned.length <= maxSize) {
      return [cleaned];
    }

    const windows: string[] = [];
    let startIndex = 0;

    while (startIndex < cleaned.length) {
      let endIndex = Math.min(startIndex + maxSize, cleaned.length);

      // Try to break on a sentence boundary or word boundary
      if (endIndex < cleaned.length) {
        const sentenceEnd = cleaned.lastIndexOf('.', endIndex);
        if (sentenceEnd > startIndex + maxSize * 0.6) {
          endIndex = sentenceEnd + 1;
        } else {
          const spaceEnd = cleaned.lastIndexOf(' ', endIndex);
          if (spaceEnd > startIndex + maxSize * 0.6) {
            endIndex = spaceEnd;
          }
        }
      }

      const chunk = cleaned.slice(startIndex, endIndex).trim();
      if (chunk.length > 0) {
        windows.push(chunk);
      }

      if (endIndex >= cleaned.length) {
        break;
      }

      startIndex = Math.max(startIndex + 1, endIndex - overlap);
    }

    return windows;
  }
}
