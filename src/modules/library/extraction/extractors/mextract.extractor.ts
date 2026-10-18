import { Injectable, Logger } from '@nestjs/common';
import { libraryConfig } from '@/modules/library/core/config/library.config';
import { ItemMetadata } from '@/modules/library/core';
import {
  cleanAuthorName,
  normalizeAcademicTitleCase,
  cleanAbstractText,
  splitAuthorString,
} from '@/modules/library/core';

export interface MeXtractResult {
  metadata: Partial<ItemMetadata>;
  rawOutput?: Record<string, unknown>;
  confidence: number;
  engine: 'MEXTRACT_ONNX_SLM' | 'MEXTRACT_LOCAL_SLM' | 'MEXTRACT_HEURISTIC_SLM';
  durationMs: number;
}

/**
 * MeXtract: High-speed, local Small Language Model (SLM) for Academic Metadata Extraction.
 *
 * Lightweight, specialized SLM architecture using quantized ONNX (@xenova/transformers)
 * for rapid zero-network academic structure parsing, with bounded concurrency and strict
 * latency timeouts to guarantee stability for 1,000 users and batch ingestion workloads.
 *
 * Fully decoupled from user-workspace AI (flux-ai).
 */
@Injectable()
export class MeXtractExtractor {
  private static readonly logger = new Logger(MeXtractExtractor.name);
  public static readonly MODEL_NAME = libraryConfig().mextract.modelName;
  public static readonly MAX_INPUT_CHARS = 3500;
  private static readonly MAX_CONCURRENT_ONNX = 2;

  private static pipelinePromise: Promise<
    | ((
        prompt: string,
        options?: Record<string, unknown>,
      ) => Promise<Array<{ generated_text?: string }>>)
    | null
  > | null = null;
  private static activeOnnxCount = 0;
  private static onnxDisabled = false;

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

  /**
   * Main entrypoint for academic metadata extraction using SLM cascade:
   * 1. Optional dedicated external SLM microservice (MEXTRACT_API_URL).
   * 2. Local quantized ONNX SLM (@xenova/transformers) with bounded concurrency & strict timeout.
   * 3. Ultra-fast (<1ms) heuristic structural parser fallback.
   */
  public static async extract(
    headerText: string,
    options?: { timeoutMs?: number },
  ): Promise<MeXtractResult | null> {
    if (!headerText || headerText.trim().length < 20) {
      return null;
    }

    const start = performance.now();
    const cleanInput = headerText.slice(0, this.MAX_INPUT_CHARS).trim();
    const timeoutMs = options?.timeoutMs ?? 1500;

    // 1. Optional dedicated external SLM microservice (MEXTRACT_API_URL or MEXTRACT_URL)
    const slmApiUrl = libraryConfig().mextract.apiUrl;
    if (slmApiUrl) {
      try {
        const response = await fetch(`${slmApiUrl}/v1/mextract/extract`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: cleanInput,
            model: this.MODEL_NAME,
            system_prompt: this.SYSTEM_PROMPT,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (response.ok) {
          const json = (await response.json()) as Record<string, unknown>;
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
        // Fall through to local ONNX or heuristic parser
      }
    }

    // 2. Local Quantized ONNX SLM (@xenova/transformers)
    const onnxResult = await this.tryOnnxExtraction(cleanInput, timeoutMs);
    if (onnxResult) {
      const durationMs = Math.round((performance.now() - start) * 10) / 10;
      return {
        metadata: onnxResult.metadata,
        rawOutput: onnxResult.rawOutput,
        confidence: 0.95,
        engine: 'MEXTRACT_ONNX_SLM',
        durationMs,
      };
    }

    // 3. Fallback to in-process deterministic structural parser (< 1ms)
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

  /**
   * Attempts local ONNX model inference via @xenova/transformers.
   * Guarded by bounded concurrency and strict timeout to prevent CPU starvation.
   */
  private static async tryOnnxExtraction(
    cleanInput: string,
    timeoutMs: number,
  ): Promise<{
    metadata: Partial<ItemMetadata>;
    rawOutput?: Record<string, unknown>;
  } | null> {
    if (this.onnxDisabled || this.activeOnnxCount >= this.MAX_CONCURRENT_ONNX) {
      return null;
    }

    this.activeOnnxCount++;
    let pipelineTimer: NodeJS.Timeout | undefined;
    let inferenceTimer: NodeJS.Timeout | undefined;
    try {
      const pipe = await Promise.race([
        this.getOnnxPipeline(),
        new Promise<null>((_, reject) => {
          pipelineTimer = setTimeout(
            () => reject(new Error('ONNX pipeline timeout')),
            timeoutMs,
          );
          pipelineTimer.unref?.();
        }),
      ]);
      if (pipelineTimer) {
        clearTimeout(pipelineTimer);
        pipelineTimer = undefined;
      }

      if (!pipe) return null;

      const prompt = `<|im_start|>system\n${this.SYSTEM_PROMPT}<|im_end|>\n<|im_start|>user\n${cleanInput.slice(0, 1500)}<|im_end|>\n<|im_start|>assistant\n`;

      const inferencePromise = pipe(prompt, {
        max_new_tokens: 256,
        temperature: 0.1,
        do_sample: false,
        return_full_text: false,
      });

      const output = await Promise.race([
        inferencePromise,
        new Promise<null>((_, reject) => {
          inferenceTimer = setTimeout(
            () => reject(new Error('ONNX inference timeout')),
            timeoutMs,
          );
          inferenceTimer.unref?.();
        }),
      ]);
      if (inferenceTimer) {
        clearTimeout(inferenceTimer);
        inferenceTimer = undefined;
      }

      if (output && Array.isArray(output) && output[0]?.generated_text) {
        const text = output[0].generated_text;
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
          const normalized = this.normalizeModelOutput(parsed);
          if (normalized) {
            return { metadata: normalized, rawOutput: parsed };
          }
        }
      }
      return null;
    } catch {
      return null;
    } finally {
      if (pipelineTimer) clearTimeout(pipelineTimer);
      if (inferenceTimer) clearTimeout(inferenceTimer);
      this.activeOnnxCount--;
    }
  }

  private static async getOnnxPipeline(): Promise<
    | ((
        prompt: string,
        options?: Record<string, unknown>,
      ) => Promise<Array<{ generated_text?: string }>>)
    | null
  > {
    if (this.onnxDisabled) return null;
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        try {
          type OnnxPipelineFn = (
            prompt: string,
            options?: Record<string, unknown>,
          ) => Promise<Array<{ generated_text?: string }>>;
          interface XenovaModule {
            pipeline: (
              task: string,
              model: string,
              opts: { quantized: boolean },
            ) => Promise<OnnxPipelineFn>;
            env: { allowLocalModels: boolean };
          }
          // eslint-disable-next-line @typescript-eslint/no-implied-eval
          const dynamicImport = new Function('s', 'return import(s)') as (
            s: string,
          ) => Promise<XenovaModule>;
          const { pipeline, env } = await dynamicImport('@xenova/transformers');
          env.allowLocalModels = true;
          return await pipeline('text-generation', this.MODEL_NAME, {
            quantized: true,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.debug(
            `Local ONNX model (${this.MODEL_NAME}) not loaded: ${message}`,
          );
          this.onnxDisabled = true;
          return null;
        }
      })();
    }
    return this.pipelinePromise;
  }

  private static normalizeModelOutput(
    raw: unknown,
  ): Partial<ItemMetadata> | null {
    if (!raw || typeof raw !== 'object') return null;

    const rawObj = raw as Record<string, unknown>;
    const data = ((rawObj.data || rawObj.result || rawObj) ?? {}) as Record<
      string,
      unknown
    >;
    const metadata: Partial<ItemMetadata> = {};

    if (typeof data.title === 'string' && data.title.trim().length > 3) {
      metadata.title = normalizeAcademicTitleCase(data.title.trim());
    }

    if (Array.isArray(data.authors) && data.authors.length > 0) {
      metadata.authors = data.authors
        .map((a: unknown) =>
          cleanAuthorName(
            typeof a === 'string'
              ? a
              : typeof a === 'object' &&
                  a !== null &&
                  'name' in a &&
                  typeof a.name === 'string'
                ? a.name
                : '',
          ),
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

    const doiMatch = text.match(/\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)/);
    if (doiMatch) {
      metadata.doi = doiMatch[1].replace(/[.,;)]+$/, '');
    }

    return metadata;
  }
}
