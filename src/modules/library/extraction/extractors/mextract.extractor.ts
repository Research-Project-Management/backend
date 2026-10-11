import { Injectable, Logger } from '@nestjs/common';
import { ItemMetadata } from '../../shared-kernel';
import {
  cleanAuthorName,
  normalizeAcademicTitleCase,
  cleanAbstractText,
  splitAuthorString,
} from '../../shared-kernel/utils/bibliographic.utils';

export interface MeXtractResult {
  metadata: Partial<ItemMetadata>;
  rawOutput?: Record<string, any>;
  confidence: number;
  engine: 'MEXTRACT_ONNX_SLM' | 'MEXTRACT_LOCAL_SLM' | 'MEXTRACT_HEURISTIC_SLM';
  durationMs: number;
}

/**
 * MeXtract: High-speed, local Small Language Model (SLM) for Academic Metadata Extraction.
 *
 * Lightweight, specialized SLM architecture (e.g. Qwen2.5-0.5B-Instruct quantized ONNX / CPU)
 * for rapid zero-network academic structure parsing.
 */
@Injectable()
export class MeXtractExtractor {
  private static readonly logger = new Logger(MeXtractExtractor.name);
  public static readonly MODEL_NAME = 'Qwen2.5-0.5B-Instruct-ONNX';
  public static readonly MAX_INPUT_CHARS = 3500;

  public static readonly SYSTEM_PROMPT = `You are MeXtract, an academic metadata extraction model. Analyze the following first-page text of a scientific paper and extract the bibliographic metadata in strict JSON format:
{
  "title": "exact title of the paper",
  "authors": ["Author 1", "Author 2"],
  "year": 2024,
  "journal": "journal or conference name",
  "abstract": "full abstract text",
  "doi": "10.xxxx/xxxx"
}
Return ONLY valid JSON without markdown fences.`;

  public static async extract(
    headerText: string,
    options?: { timeoutMs?: number },
  ): Promise<MeXtractResult | null> {
    if (!headerText || headerText.trim().length < 20) {
      return null;
    }

    const start = performance.now();
    const cleanInput = headerText.slice(0, this.MAX_INPUT_CHARS).trim();

    const aiUrl = process.env.FLUX_AI_URL;
    if (aiUrl) {
      try {
        const response = await fetch(`${aiUrl}/v1/mextract/extract`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: cleanInput,
            model: this.MODEL_NAME,
            system_prompt: this.SYSTEM_PROMPT,
          }),
          signal: AbortSignal.timeout(options?.timeoutMs ?? 1500),
        });

        if (response.ok) {
          const json = await response.json();
          const durationMs = Math.round((performance.now() - start) * 10) / 10;
          const normalized = this.normalizeModelOutput(json);
          if (normalized) {
            return {
              metadata: normalized,
              rawOutput: json,
              confidence: 0.95,
              engine: 'MEXTRACT_LOCAL_SLM',
              durationMs,
            };
          }
        }
      } catch {
        // Fallback to in-process parser
      }
    }

    const inProcessParsed = this.inProcessStructureParse(cleanInput);
    const durationMs = Math.round((performance.now() - start) * 10) / 10;

    if (
      inProcessParsed &&
      (inProcessParsed.title || inProcessParsed.authors?.length)
    ) {
      return {
        metadata: inProcessParsed,
        confidence:
          inProcessParsed.title && inProcessParsed.authors?.length ? 0.9 : 0.82,
        engine: 'MEXTRACT_HEURISTIC_SLM',
        durationMs,
      };
    }

    return null;
  }

  private static normalizeModelOutput(raw: any): Partial<ItemMetadata> | null {
    if (!raw || typeof raw !== 'object') return null;

    const data = raw.data || raw.result || raw;
    const metadata: Partial<ItemMetadata> = {};

    if (typeof data.title === 'string' && data.title.trim().length > 3) {
      metadata.title = normalizeAcademicTitleCase(data.title.trim());
    }

    if (Array.isArray(data.authors) && data.authors.length > 0) {
      metadata.authors = data.authors
        .map((a: any) =>
          cleanAuthorName(typeof a === 'string' ? a : a.name || ''),
        )
        .filter(Boolean);
    } else if (
      typeof data.authors === 'string' &&
      data.authors.trim().length > 2
    ) {
      metadata.authors = splitAuthorString(data.authors)
        .map((a: string) => cleanAuthorName(a))
        .filter(Boolean);
    }

    if (typeof data.year === 'number' && data.year > 1800 && data.year < 2100) {
      metadata.year = data.year;
    } else if (typeof data.year === 'string') {
      const parsedYear = parseInt(data.year, 10);
      if (!isNaN(parsedYear) && parsedYear > 1800 && parsedYear < 2100) {
        metadata.year = parsedYear;
      }
    }

    if (typeof data.journal === 'string' && data.journal.trim().length > 2) {
      metadata.journal = data.journal.trim();
      metadata.publicationTitle = data.journal.trim();
    }

    if (typeof data.abstract === 'string' && data.abstract.trim().length > 20) {
      metadata.abstract = cleanAbstractText(data.abstract.trim());
    }

    if (
      typeof data.doi === 'string' &&
      /^10\.\d{4,9}\//.test(data.doi.trim())
    ) {
      metadata.doi = data.doi.trim().replace(/[.,;)]+$/, '');
    }

    return Object.keys(metadata).length > 0 ? metadata : null;
  }

  private static inProcessStructureParse(text: string): Partial<ItemMetadata> {
    const metadata: Partial<ItemMetadata> = {};
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) return metadata;

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
        metadata.abstract = cleanAbstractText(abstractContent);
      }
    }

    const headerLines =
      abstractStart !== -1 ? lines.slice(0, abstractStart) : lines.slice(0, 15);
    const candidateTitleLines: string[] = [];

    for (const line of headerLines) {
      if (
        /^(arxiv[:\s._/-]*\d|https?:|\d+$|submitted to|proceedings of|ieee|acm|springer|elsevier|under review|copyright)/i.test(
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
      metadata.title = normalizeAcademicTitleCase(
        candidateTitleLines.join(' '),
      );
    }

    const titleLineCount = candidateTitleLines.length;
    const authorCandidates = headerLines.slice(titleLineCount);
    for (const line of authorCandidates) {
      if (
        !/university|department|laboratory|institute|school|faculty|hospital|center for|group/i.test(
          line,
        )
      ) {
        const potentialAuthors = splitAuthorString(line)
          .map((a: string) => cleanAuthorName(a))
          .filter((a: string) => a.length > 2 && a.length < 50);
        if (potentialAuthors.length > 0) {
          metadata.authors = potentialAuthors;
          break;
        }
      }
    }

    const currentYear = new Date().getFullYear();
    const allYears = [...text.slice(0, 2500).matchAll(/\b(19\d{2}|20\d{2})\b/g)]
      .map((m) => parseInt(m[1], 10))
      .filter((y) => y >= 1950 && y <= currentYear + 2);
    if (allYears.length > 0) {
      metadata.year = allYears[allYears.length - 1];
    }

    return metadata;
  }
}
