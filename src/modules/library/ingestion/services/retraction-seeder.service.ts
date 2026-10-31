import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  normalizeDoi,
  normalizePmid,
  ExternalProviderException,
} from '@/modules/library/core';
import { RetractionRepository } from '@/modules/library/ingestion/repositories/retraction.repository';
import { RetractionDatabaseService } from '@/modules/library/ingestion/services/retraction-database.service';

export interface RetractionSeedResult {
  totalRows: number;
  validRecords: number;
  inserted: number;
  durationMs: number;
  deltaDois?: string[];
}

export function* iterateRfc4180Csv(
  csvText: string,
): Generator<Record<string, string>> {
  let headers: string[] | null = null;
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;
  const len = csvText.length;

  const emitRow = (row: string[]): Record<string, string> | null => {
    if (!row.some((f) => f.trim().length > 0)) {
      return null;
    }
    if (!headers) {
      headers = row.map((h) => h.trim().replace(/^[\uFEFF]/, ''));
      return null;
    }
    const record: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      record[headers[c]] = row[c] !== undefined ? row[c].trim() : '';
    }
    return record;
  };

  while (i < len) {
    const char = csvText[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < len && csvText[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
        }
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        currentRow.push(currentField);
        currentField = '';
      } else if (char === '\r') {
        if (i + 1 < len && csvText[i + 1] === '\n') {
          i++;
        }
        currentRow.push(currentField);
        currentField = '';
        const rec = emitRow(currentRow);
        currentRow = [];
        if (rec) yield rec;
      } else if (char === '\n') {
        currentRow.push(currentField);
        currentField = '';
        const rec = emitRow(currentRow);
        currentRow = [];
        if (rec) yield rec;
      } else {
        currentField += char;
      }
    }
    i++;
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    const rec = emitRow(currentRow);
    if (rec) yield rec;
  }
}

export function parseRfc4180Csv(
  csvText: string,
): Array<Record<string, string>> {
  return Array.from(iterateRfc4180Csv(csvText));
}

export function cleanRetractionReason(rawReason?: string): string {
  if (!rawReason) return '';
  return rawReason
    .split(';')
    .map((r) => r.trim().replace(/^\+/, ''))
    .filter((r) => r.length > 0)
    .join('; ');
}

export function parseRetractionNature(natureRaw?: string): {
  nature: string;
  isRetracted: boolean;
} {
  const norm = (natureRaw || '').toLowerCase();
  if (norm.includes('reinstatement')) {
    return { nature: 'reinstatement', isRetracted: false };
  }
  if (norm.includes('concern')) {
    return { nature: 'expression_of_concern', isRetracted: true };
  }
  if (
    norm.includes('correction') ||
    norm.includes('erratum') ||
    norm.includes('corrigendum')
  ) {
    return { nature: 'correction', isRetracted: true };
  }
  return { nature: 'retraction', isRetracted: true };
}

@Injectable()
export class RetractionSeederService {
  private readonly logger = new Logger(RetractionSeederService.name);
  public static readonly OFFICIAL_GITLAB_CSV_URL =
    'https://gitlab.com/crossref/retraction-watch-data/-/raw/main/retraction_watch.csv';

  constructor(
    private readonly repo: RetractionRepository,
    private readonly retractionDb: RetractionDatabaseService,
  ) {}

  /**
   * Seeds the PostgreSQL `retractions` table directly from CSV text.
   */
  async seedFromCsv(
    csvContent: string,
    options?: { chunkSize?: number; warmCache?: boolean },
  ): Promise<RetractionSeedResult> {
    const startTime = Date.now();
    const chunkSize = options?.chunkSize ?? 1000;
    let totalRows = 0;
    let validRecords = 0;
    let inserted = 0;

    const seenDois = new Set<string>();
    const deltaDois: string[] = [];
    const pendingBatch: Prisma.RetractionCreateManyInput[] = [];

    const flushBatch = async (batch: Prisma.RetractionCreateManyInput[]) => {
      if (!batch.length) return 0;
      const count = await this.repo.bulkCreateRetractions(batch);
      if (count > 0) {
        for (const item of batch) {
          deltaDois.push(item.doi);
        }
      }
      return count;
    };

    for (const row of iterateRfc4180Csv(csvContent)) {
      totalRows++;
      const rawDoi = row['OriginalPaperDOI'] || row['OriginalPaperDoi'];
      if (!rawDoi || /unavailable/i.test(rawDoi)) continue;

      const cleanDoi = normalizeDoi(rawDoi) || rawDoi.trim().toLowerCase();
      if (!cleanDoi || seenDois.has(cleanDoi)) continue;
      seenDois.add(cleanDoi);

      const rawPmid =
        row['OriginalPaperPubMedID'] || row['OriginalPaperPubmedId'];
      const cleanPmid =
        rawPmid && rawPmid !== '0' && !/unavailable/i.test(rawPmid)
          ? normalizePmid(rawPmid) || rawPmid.trim()
          : null;

      const { nature, isRetracted } = parseRetractionNature(
        row['RetractionNature'],
      );
      const reason = cleanRetractionReason(row['Reason']);
      const noticeDoi = row['RetractionDOI'];
      const noticeUrl =
        noticeDoi && !/unavailable/i.test(noticeDoi)
          ? noticeDoi.startsWith('http')
            ? noticeDoi
            : `https://doi.org/${noticeDoi.trim()}`
          : row['URLS']?.split(';')[0]?.trim() || null;

      let retractionDate: Date | null = null;
      const rawDate = row['RetractionDate'];
      if (rawDate) {
        const parsed = new Date(rawDate);
        if (!isNaN(parsed.getTime())) retractionDate = parsed;
      }

      pendingBatch.push({
        doi: cleanDoi,
        pmid: cleanPmid,
        title: row['Title'] ? row['Title'].slice(0, 1000) : null,
        journal: row['Journal'] ? row['Journal'].slice(0, 500) : null,
        isRetracted,
        nature,
        noticeType: nature,
        reason: reason ? reason.slice(0, 2000) : null,
        noticeUrl,
        retractionDate,
        source: 'retraction_watch',
        checkedAt: new Date(),
      });

      this.retractionDb.addRetractionToBloom?.(cleanDoi);
      if (cleanPmid) this.retractionDb.addRetractionToBloom?.(cleanPmid);

      validRecords++;

      if (pendingBatch.length >= chunkSize) {
        const count = await flushBatch(
          pendingBatch.splice(0, pendingBatch.length),
        );
        inserted += count;
      }
    }

    if (pendingBatch.length > 0) {
      const count = await flushBatch(
        pendingBatch.splice(0, pendingBatch.length),
      );
      inserted += count;
    }

    if (options?.warmCache !== false) {
      await this.retractionDb.warmMemoryIndex();
    }

    const durationMs = Date.now() - startTime;
    this.logger.log(
      `Retraction Watch CSV Seeding complete: ${totalRows} rows parsed, ${validRecords} valid DOIs, ${inserted} inserted, ${deltaDois.length} delta DOIs in ${durationMs}ms`,
    );

    return {
      totalRows,
      validRecords,
      inserted,
      durationMs,
      deltaDois,
    };
  }

  /**
   * Fetches the official daily CSV dump from Crossref GitLab and seeds it.
   */
  async seedFromGitlab(
    url = RetractionSeederService.OFFICIAL_GITLAB_CSV_URL,
  ): Promise<RetractionSeedResult> {
    this.logger.log(
      `Fetching Retraction Watch dataset from official Crossref repository: ${url}`,
    );
    const res = await fetch(url, {
      headers: { Accept: 'text/csv, text/plain' },
    });
    if (!res.ok) {
      throw new ExternalProviderException(
        `Failed to fetch Crossref Retraction Watch CSV from ${url}: HTTP ${res.status} ${res.statusText}`,
      );
    }
    const csvContent = await res.text();
    return this.seedFromCsv(csvContent);
  }
}
