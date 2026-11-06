import * as fs from 'fs';
import * as path from 'path';
import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { normalizeDoi, normalizePmid, ExternalProviderException, EntityNotFoundException, LIBRARY_EVENT_TYPES, ReconcileExtractedCandidatePayload, HttpClient } from '@/modules/library/core';
import { RetractionRepository } from '@/modules/library/ingestion/repositories/retraction.repository';
import { RetractionDatabaseService } from '@/modules/library/ingestion/services/retraction-database.service';
import { OnEvent } from '@nestjs/event-emitter';
import { RETRACTION_SERVICE_PORT, IRetractionCheckPort } from '@/modules/library/ingestion/types/ingestion.types';
import { MetadataResolverService } from '@/modules/library/ingestion/services/metadata-resolver.service';
import { createHash } from 'crypto';
import { RedisCacheService } from '@/core';
import { QueryType, ResolvedMetadata } from '@/modules/library/ingestion/types/metadata.types';
import { METADATA_POLICY_VERSION } from '@/modules/library/ingestion/domain/metadata.policy';

interface RetractionSeedResult {
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
    return { nature: 'correction', isRetracted: false };
  }
  return { nature: 'retraction', isRetracted: true };
}

@Injectable()
export class RetractionSeederService {
  private readonly logger = new Logger(RetractionSeederService.name);
  public static readonly OFFICIAL_GITLAB_CSV_URL =
    'https://gitlab.com/crossref/retraction-watch-data/-/raw/main/retraction_watch.csv';
  private lastGitlabEtag: string | null = null;
  private lastGitlabModified: string | null = null;

  constructor(
    private readonly repo: RetractionRepository,
    private readonly retractionDb: RetractionDatabaseService,
    @Optional() private readonly httpClient?: HttpClient,
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

      if (isRetracted) {
        this.retractionDb.addRetractionToBloom?.(cleanDoi);
        if (cleanPmid) this.retractionDb.addRetractionToBloom?.(cleanPmid);
      }

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
    const reqHeaders: Record<string, string> = {
      Accept: 'text/csv, text/plain',
      ...(this.lastGitlabEtag ? { 'If-None-Match': this.lastGitlabEtag } : {}),
      ...(this.lastGitlabModified
        ? { 'If-Modified-Since': this.lastGitlabModified }
        : {}),
    };
    const rawRes = this.httpClient
      ? await this.httpClient.request(url, {
          headers: reqHeaders,
          timeoutMs: 120_000,
          maxBytes: 150 * 1024 * 1024,
        })
      : await fetch(url, {
          headers: reqHeaders,
        });
    const res = 'response' in rawRes ? rawRes.response : rawRes;
    if (res.status === 304) {
      this.logger.log(
        'Crossref Retraction Watch CSV unchanged (HTTP 304 Not Modified); skipping download.',
      );
      return {
        totalRows: 0,
        validRecords: 0,
        inserted: 0,
        durationMs: 0,
        deltaDois: [],
      };
    }
    if (!res.ok) {
      throw new ExternalProviderException(
        `Failed to fetch Crossref Retraction Watch CSV from ${url}: HTTP ${res.status} ${res.statusText}`,
      );
    }
    const etag = res.headers?.get?.('etag');
    const lastMod = res.headers?.get?.('last-modified');
    if (etag) this.lastGitlabEtag = etag;
    if (lastMod) this.lastGitlabModified = lastMod;
    const csvContent = await res.text();
    return this.seedFromCsv(csvContent);
  }
}

interface SeedRetractionsCommandOptions {
  filePath?: string;
  url?: string;
  chunkSize?: number;
}

@Injectable()
export class SeedRetractionsCommand {
  private readonly logger = new Logger(SeedRetractionsCommand.name);

  constructor(private readonly seeder: RetractionSeederService) {}

  async execute(
    options?: SeedRetractionsCommandOptions,
  ): Promise<RetractionSeedResult> {
    if (options?.filePath) {
      const resolvedPath = path.resolve(process.cwd(), options.filePath);
      this.logger.log(
        `Executing Retraction Seeder from local file: ${resolvedPath}`,
      );
      if (!fs.existsSync(resolvedPath)) {
        throw new EntityNotFoundException(
          `Retraction seed CSV file not found at: ${resolvedPath}`,
        );
      }
      const content = fs.readFileSync(resolvedPath, 'utf8');
      return this.seeder.seedFromCsv(content, { chunkSize: options.chunkSize });
    }

    if (options?.url) {
      this.logger.log(
        `Executing Retraction Seeder from custom URL: ${options.url}`,
      );
      return this.seeder.seedFromGitlab(options.url);
    }

    this.logger.log(
      'Executing Retraction Seeder from official Crossref GitLab repository',
    );
    return this.seeder.seedFromGitlab();
  }
}

const IDENTIFIER_FIELD_GROUPS = ['doi', 'pmid', 'fields', 'metadata'];

@Injectable()
export class RetractionItemEventsSubscriber {
  private readonly logger = new Logger(RetractionItemEventsSubscriber.name);

  constructor(
    @Optional()
    @Inject(RETRACTION_SERVICE_PORT)
    private readonly retraction?: IRetractionCheckPort,
    @Optional() private readonly metadataResolver?: MetadataResolverService,
  ) {}

  @OnEvent(LIBRARY_EVENT_TYPES.ATTACHMENT_METADATA_EXTRACTED, { async: true })
  async handleAttachmentMetadataExtracted(
    event: ReconcileExtractedCandidatePayload | Record<string, unknown>,
  ): Promise<void> {
    if (!this.metadataResolver) return;
    const rawPayload = (event as Record<string, unknown>)?.payload ?? event;
    const effectivePayload = (rawPayload && typeof rawPayload === 'object' ? rawPayload : event) as Record<string, unknown>;
    const itemId = (effectivePayload.itemId || (event as Record<string, unknown>)?.aggregateId) as string | undefined;
    const userId = (effectivePayload.userId || (event as Record<string, unknown>)?.userId || (event as { scope?: { userId?: string } })?.scope?.userId) as string | undefined;
    if (!itemId || !userId) return;

    try {
      const reconcilePayload: ReconcileExtractedCandidatePayload = {
        ...(effectivePayload as unknown as ReconcileExtractedCandidatePayload),
        itemId,
        userId,
      };
      await this.metadataResolver.reconcileExtractedCandidate(reconcilePayload);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Single-authority reconciliation after extraction skipped for item ${itemId}: ${message}`,
      );
    }
  }

  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_UPDATED, { async: true })
  async handleItemUpdated(event: {
    aggregateId?: string;
    itemId?: string;
    userId?: string | null;
    projectId?: string | null;
    payload?: { updatedFields?: string[]; userId?: string; projectId?: string; itemId?: string; doi?: string; pmid?: string; source?: string; metadata?: { doi?: string; pmid?: string } };
  }): Promise<void> {
    if (!this.retraction) return;

    const itemId = event?.aggregateId || event?.itemId || event?.payload?.itemId;
    const userId = event?.userId ?? event?.payload?.userId ?? undefined;
    if (!itemId || !userId) return;

    const payload = event.payload as
      | {
          updatedFields?: string[];
          userId?: string;
          projectId?: string;
          source?: string;
          doi?: string | null;
          pmid?: string | null;
          metadata?: { doi?: string | null; pmid?: string | null };
        }
      | undefined;
    const updatedFields = payload?.updatedFields;
    const source = payload?.source;
    if (
      source === 'retraction_watch' ||
      (Array.isArray(updatedFields) &&
        (updatedFields.includes('retractionCheckedAt') ||
          updatedFields.includes('isRetracted')))
    ) {
      return;
    }
    const hasExplicitIdentifierInPayload = Boolean(
      payload?.doi ||
        payload?.pmid ||
        payload?.metadata?.doi ||
        payload?.metadata?.pmid,
    );
    const effectiveFieldGroups =
      source === 'extraction.metadata_sync'
        ? ['doi', 'pmid']
        : IDENTIFIER_FIELD_GROUPS;
    const mayAffectIdentifier = Array.isArray(updatedFields)
      ? updatedFields.some((f) => effectiveFieldGroups.includes(f)) ||
        hasExplicitIdentifierInPayload
      : hasExplicitIdentifierInPayload;
    if (!mayAffectIdentifier) return;

    try {
      await this.retraction.checkItem(
        userId,
        itemId,
        event.projectId ?? event.payload?.projectId ?? undefined,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Retraction re-check after update skipped for item ${itemId}: ${message}`,
      );
    }
  }
}

const NEGATIVE_SENTINEL = '__metadata_negative__';

interface L1CacheEntry {
  value: ResolvedMetadata | false;
  expiresAt: number;
}

@Injectable()
export class MetadataCache {
  private readonly logger = new Logger(MetadataCache.name);

  // Positive TTLs (seconds)
  private readonly TTL_MAP: Record<QueryType, number> = {
    DOI: 7 * 86_400, // 7 days
    ARXIV: 7 * 86_400, // 7 days
    PMID: 7 * 86_400, // 7 days
    ISBN: 14 * 86_400, // 14 days
    URL: 86_400, // 24 hours
    TITLE: 86_400, // 24 hours
  };

  // Negative TTLs (seconds) — short so new preprints/papers are discovered quickly
  private readonly NEGATIVE_TTL_MAP: Record<QueryType, number> = {
    DOI: 3_600, // 1 hour
    ARXIV: 3_600, // 1 hour
    PMID: 3_600, // 1 hour
    ISBN: 7_200, // 2 hours
    URL: 900, // 15 minutes
    TITLE: 900, // 15 minutes
  };

  // Tier 1: High-Performance In-Memory LRU Cache (<0.05ms latency)
  private readonly l1Cache = new Map<string, L1CacheEntry>();
  private readonly MAX_L1_ENTRIES = 1000;

  constructor(@Optional() private readonly redis?: RedisCacheService) {}

  buildKey(queryType: QueryType, canonicalId: string): string {
    const hash = createHash('md5')
      .update(canonicalId.toLowerCase().trim())
      .digest('hex');
    return `metadata:v${METADATA_POLICY_VERSION}:${queryType}:${hash}`;
  }

  private resolveQueryTypeFromKey(
    key: string,
    explicitType?: QueryType,
  ): QueryType | undefined {
    if (explicitType && explicitType in this.TTL_MAP) {
      return explicitType;
    }
    const parts = key.split(':');
    const candidate = parts.length >= 3 ? (parts[2] as QueryType) : undefined;
    return candidate && candidate in this.TTL_MAP ? candidate : undefined;
  }

  /**
   * Retrieves metadata from L1 memory or L2 Redis.
   */
  async get(
    key: string,
    queryType?: QueryType,
  ): Promise<ResolvedMetadata | null | false> {
    const now = Date.now();
    const resolvedQueryType = this.resolveQueryTypeFromKey(key, queryType);

    // 1. Tier 1: Check L1 In-Memory LRU Cache (0ms)
    const l1Entry = this.l1Cache.get(key);
    if (l1Entry) {
      if (l1Entry.expiresAt > now) {
        // Refresh LRU order
        this.l1Cache.delete(key);
        this.l1Cache.set(key, l1Entry);

        if (l1Entry.value === false) {
          this.logger.debug(`L1 Negative Cache HIT: ${key}`);
          return false;
        }
        this.logger.debug(`L1 Cache HIT (0ms): ${key}`);
        return l1Entry.value;
      } else {
        // Expired entry
        this.l1Cache.delete(key);
      }
    }

    // 2. Tier 2: Check L2 Redis Cache
    if (!this.redis || !this.redis.isReady()) {
      return null;
    }

    try {
      const raw = await this.redis.get<string | ResolvedMetadata>(key);
      if (raw === null || raw === undefined) return null;

      if (raw === NEGATIVE_SENTINEL) {
        this.logger.debug(`L2 Redis Negative Cache HIT: ${key}`);
        const negativeTtl = resolvedQueryType
          ? (this.NEGATIVE_TTL_MAP[resolvedQueryType] ?? 900)
          : 900;
        this.setL1(key, false, negativeTtl);
        return false;
      }

      this.logger.debug(`L2 Redis Cache HIT: ${key}`);
      const parsed: ResolvedMetadata =
        typeof raw === 'string' ? (JSON.parse(raw) as ResolvedMetadata) : raw;

      const positiveTtl = resolvedQueryType
        ? (this.TTL_MAP[resolvedQueryType] ?? 3_600)
        : 3_600;
      this.setL1(key, parsed, positiveTtl);
      return parsed;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Cache GET failed for key "${key}": ${msg}`);
      return null;
    }
  }

  /**
   * Sets positive resolved metadata in both L1 In-Memory and L2 Redis.
   */
  async set(
    key: string,
    value: ResolvedMetadata,
    queryType: QueryType,
  ): Promise<void> {
    const ttl = this.TTL_MAP[queryType] ?? 86_400;

    // 1. Set L1 In-Memory
    this.setL1(key, value, ttl);

    // 2. Set L2 Redis
    if (!this.redis || !this.redis.isReady()) return;

    try {
      await this.redis.set(key, value, ttl);
      this.logger.debug(`L2 Redis SET (TTL=${ttl}s): ${key}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`L2 Cache SET failed for key "${key}": ${msg}`);
    }
  }

  /**
   * Sets negative sentinel in both L1 In-Memory and L2 Redis.
   */
  async setNegative(key: string, queryType: QueryType): Promise<void> {
    const ttl = this.NEGATIVE_TTL_MAP[queryType] ?? 900;

    // 1. Set L1 In-Memory negative
    this.setL1(key, false, ttl);

    // 2. Set L2 Redis negative
    if (!this.redis || !this.redis.isReady()) return;

    try {
      await this.redis.set(key, NEGATIVE_SENTINEL, ttl);
      this.logger.debug(`L2 Redis Negative SET (TTL=${ttl}s): ${key}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`L2 Negative SET failed for key "${key}": ${msg}`);
    }
  }

  /**
   * Internal helper to insert/update entry in L1 LRU Cache.
   */
  private setL1(
    key: string,
    value: ResolvedMetadata | false,
    ttlSeconds: number,
  ): void {
    const now = Date.now();
    if (this.l1Cache.has(key)) {
      this.l1Cache.delete(key);
    } else if (this.l1Cache.size >= this.MAX_L1_ENTRIES) {
      for (const [k, entry] of this.l1Cache.entries()) {
        if (entry.expiresAt <= now) {
          this.l1Cache.delete(k);
        }
      }
      if (this.l1Cache.size >= this.MAX_L1_ENTRIES) {
        const oldestKey = this.l1Cache.keys().next().value;
        if (oldestKey !== undefined) {
          this.l1Cache.delete(oldestKey);
        }
      }
    }

    const expiresAt = now + ttlSeconds * 1000;
    this.l1Cache.set(key, { value, expiresAt });
  }

  /**
   * Clears L1 in-memory cache (primarily for unit tests).
   */
  clearMemoryCache(): void {
    this.l1Cache.clear();
  }

  get available(): boolean {
    return true;
  }

  get redisAvailable(): boolean {
    return Boolean(this.redis && this.redis.isReady());
  }
}
