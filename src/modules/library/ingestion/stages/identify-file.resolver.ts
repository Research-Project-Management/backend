import { createHash } from 'node:crypto';
import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import {
  EXTRACTION_FACADE,
  IExtractionFacade,
  cleanPdfTitle,
  inferItemTypeFromPdfSignals,
} from '@/modules/library/core';
import { SubmissionPayload } from '@/modules/library/ingestion/types/ingestion.types';
import { MetadataCandidate } from '@/modules/library/ingestion/types/metadata.types';
import { NormalizationPolicy } from '@/modules/library/ingestion/domain/normalization.policy';
import { createCandidate } from '../domain/metadata-validation.policy';

export { cleanPdfTitle };

export interface ExtractedPdfMetadata {
  title?: string;
  authors?: Array<
    | string
    | {
        fullName?: string | null;
        name?: string | null;
        firstName?: string | null;
        lastName?: string | null;
      }
  >;
  creators?: Array<
    | string
    | {
        fullName?: string | null;
        name?: string | null;
        firstName?: string | null;
        lastName?: string | null;
      }
  >;
  doi?: string;
  arxivId?: string;
  isbn?: string;
  year?: number;
  publicationDate?: string;
  publisher?: string;
  publicationTitle?: string;
  journal?: string;
  pages?: string;
  tags?: string[];
  keywords?: string[];
  referenceCount?: number;
  citationCount?: number;
  notes?: Array<string | { content?: string }>;
  extraFields?: Record<string, unknown>;
  numberOfPages?: number;
  isSelfSufficient?: boolean;
  qualityScore?: number;
  engineUsed?: string;
  conferenceName?: string;
  bookTitle?: string;
  itemType?: string;
  rawText?: string;
  creationDate?: string;
  [key: string]: unknown;
}

function mergeExtractedPdfMetadata(
  primary: ExtractedPdfMetadata,
  fallback?: ExtractedPdfMetadata,
): ExtractedPdfMetadata {
  if (!fallback || Object.keys(fallback).length === 0) return primary;
  if (Object.keys(primary).length === 0) return fallback;

  const merged: Record<string, unknown> = { ...primary };
  const primaryRec = primary as Record<string, unknown>;
  const fallbackProv = (fallback.fieldProvenance || {}) as Record<string, unknown>;
  const mergedProv: Record<string, unknown> = {
    ...((primaryRec.fieldProvenance as Record<string, unknown>) || {}),
  };

  for (const [k, v] of Object.entries(fallback)) {
    if (k === 'fieldProvenance' || v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    const cur = primaryRec[k];
    const isCurEmpty =
      cur === undefined ||
      cur === null ||
      cur === '' ||
      (Array.isArray(cur) && cur.length === 0) ||
      (k === 'title' && cur === 'Uploaded Document');
    if (isCurEmpty) {
      merged[k] = v;
      if (fallbackProv[k] && !mergedProv[k]) {
        mergedProv[k] = fallbackProv[k];
      }
    }
  }
  if (Object.keys(mergedProv).length > 0) {
    merged.fieldProvenance = mergedProv;
  }
  return merged as unknown as ExtractedPdfMetadata;
}

const PDF_CONTENT_CACHE_MAX_ENTRIES = 500;
const PDF_CONTENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class IdentifyFileResolver {
  private readonly logger = new Logger(IdentifyFileResolver.name);
  private readonly contentHashCache = new Map<
    string,
    { metadata: ExtractedPdfMetadata; expiresAt: number }
  >();
  private readonly inFlightExtractions = new Map<
    string,
    Promise<ExtractedPdfMetadata>
  >();

  constructor(
    private readonly normalizer: NormalizationPolicy,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional()
    @Inject(EXTRACTION_FACADE)
    private readonly extractionGateway?: IExtractionFacade,
  ) {}

  private cloneMetadata(meta: ExtractedPdfMetadata): ExtractedPdfMetadata {
    return {
      ...meta,
      ...(meta.extraFields ? { extraFields: { ...meta.extraFields } } : {}),
      ...(Array.isArray(meta.authors) ? { authors: [...meta.authors] } : {}),
      ...(Array.isArray(meta.creators) ? { creators: [...meta.creators] } : {}),
    };
  }

  private async extractBufferMetadataOnce(
    fileBuffer: Buffer,
  ): Promise<ExtractedPdfMetadata> {
    const contentHash = createHash('sha256').update(fileBuffer).digest('hex');
    const now = Date.now();
    const cached = this.contentHashCache.get(contentHash);
    if (cached && cached.expiresAt > now) {
      return this.cloneMetadata(cached.metadata);
    }
    if (cached) {
      this.contentHashCache.delete(contentHash);
    }

    const existingInFlight = this.inFlightExtractions.get(contentHash);
    if (existingInFlight) {
      const shared = await existingInFlight;
      return this.cloneMetadata(shared);
    }

    const task = (async (): Promise<ExtractedPdfMetadata> => {
      let result: ExtractedPdfMetadata = {};

      if (this.extractionGateway?.extractTrustedMetadata) {
        try {
          // Pass undefined for filename so global content-hash cache remains 100% pure content-derived
          const trusted = await this.extractionGateway.extractTrustedMetadata(
            fileBuffer,
            undefined,
          );
          if (trusted?.metadata) {
            result = {
              ...(trusted.metadata as unknown as ExtractedPdfMetadata),
              isSelfSufficient: trusted.isSelfSufficient,
              qualityScore: trusted.quality?.totalScore,
              engineUsed: trusted.provenance?.engineUsed,
            };
          }
        } catch {
          // Fall through to header document extraction
        }
      }

      const needsDocumentFallback =
        Object.keys(result).length === 0 ||
        (!result.doi &&
          !result.arxivId &&
          !result.isbn &&
          (!result.title || result.title === 'Uploaded Document'));

      if (
        needsDocumentFallback &&
        this.extractionGateway?.extractDocumentFromBuffer
      ) {
        const extractedDoc =
          await this.extractionGateway.extractDocumentFromBuffer(fileBuffer, {
            maxPages: 3,
            headerOnly: true,
            skipTrustedExtraction: true,
          });
        const docMeta =
          ((extractedDoc?.metadata ||
            extractedDoc) as unknown as ExtractedPdfMetadata) || {};
        result = mergeExtractedPdfMetadata(result, docMeta);
      }

      if (
        Object.keys(result).length === 0 &&
        this.extractionGateway?.extractMetadataFromBuffer
      ) {
        try {
          result =
            (this.extractionGateway.extractMetadataFromBuffer(
              fileBuffer,
            ) as unknown as ExtractedPdfMetadata) || {};
        } catch {
          result = {};
        }
      }

      if (Object.keys(result).length > 0) {
        if (this.contentHashCache.size >= PDF_CONTENT_CACHE_MAX_ENTRIES) {
          const oldestKey = this.contentHashCache.keys().next().value;
          if (oldestKey) this.contentHashCache.delete(oldestKey);
        }
        this.contentHashCache.set(contentHash, {
          metadata: this.cloneMetadata(result),
          expiresAt: Date.now() + PDF_CONTENT_CACHE_TTL_MS,
        });
      }

      return result;
    })();

    this.inFlightExtractions.set(contentHash, task);
    try {
      const resolved = await task;
      return this.cloneMetadata(resolved);
    } finally {
      this.inFlightExtractions.delete(contentHash);
    }
  }

  cleanPdfTitle(
    rawTitle?: unknown,
    filename?: string,
    authors?: unknown[],
    creators?: unknown[],
  ): string {
    return cleanPdfTitle(rawTitle, filename, authors, creators);
  }

  async resolve(
    payload: SubmissionPayload & { kind: 'FILE' },
    scopeOrContext?:
      string | { userId?: string; projectId?: string; scopeId?: string },
  ): Promise<MetadataCandidate> {
    const context =
      typeof scopeOrContext === 'string'
        ? {
            scopeId: scopeOrContext,
            projectId:
              scopeOrContext && scopeOrContext !== 'user'
                ? scopeOrContext
                : undefined,
          }
        : {
            scopeId: scopeOrContext?.scopeId,
            userId: scopeOrContext?.userId,
            projectId:
              scopeOrContext?.projectId ??
              (scopeOrContext?.scopeId &&
              scopeOrContext.scopeId !== 'user' &&
              scopeOrContext.scopeId !== scopeOrContext?.userId
                ? scopeOrContext.scopeId
                : undefined),
          };
    let extractedMetadata: ExtractedPdfMetadata = {};
    let fileBuffer: Buffer | undefined;

    const rawPayloadAny = payload as unknown as Record<string, unknown>;
    const rawOverrides = (rawPayloadAny.overrides || {}) as Record<
      string,
      unknown
    >;
    const inlineExtracted = rawPayloadAny.extractedMetadata as
      | Record<string, unknown>
      | undefined;
    if (inlineExtracted && typeof inlineExtracted === 'object') {
      extractedMetadata = { ...extractedMetadata, ...inlineExtracted };
    }

    const filenameWithoutPdf = payload.filename
      ? payload.filename.replace(/\.pdf$/i, '')
      : undefined;
    const rawFilenameDoi = filenameWithoutPdf?.match(
      /10\.\d{4,9}[/_@][-._;()/:A-Za-z0-9]+/,
    )?.[0];
    const filenameDoi = rawFilenameDoi
      ? rawFilenameDoi
          .replace(/^(10\.\d{4,9})[_@]/, '$1/')
          .replace(/[.,;:)\]]+$/, '')
      : undefined;

    const explicitArxivMatch = payload.filename?.match(
      /arxiv[:_.-]*((?:\d{2})(?:0[1-9]|1[0-2])\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?\/\d{7}(?:v\d+)?)/i,
    )?.[1];
    const bareArxivMatch = !explicitArxivMatch
      ? payload.filename?.match(
          /(?:^|[^0-9])(?!(?:19|20)\d{2}\.)(\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}(?:v\d+)?)(?=$|[^0-9])/i,
        )?.[1]
      : undefined;
    const filenameArxivId = explicitArxivMatch || bareArxivMatch;

    if (
      this.storagePort?.readOwnedFile &&
      this.extractionGateway?.extractDocumentFromBuffer &&
      payload.fileId
    ) {
      try {
        const fileRecord = await this.storagePort.readOwnedFile({
          fileId: payload.fileId,
          userId: context.userId,
          projectId: context.projectId,
        });
        if (fileRecord?.buffer) {
          fileBuffer = fileRecord.buffer;
          const bufferExtracted =
            await this.extractBufferMetadataOnce(fileBuffer);
          extractedMetadata = mergeExtractedPdfMetadata(
            extractedMetadata,
            bufferExtracted,
          );
        }
      } catch (caughtError: unknown) {
        this.logger.warn(
          `PDF metadata extraction failed for file ${payload.fileId}: ${caughtError instanceof Error ? caughtError.message : String(caughtError)}`,
        );
      }
    }

    const {
      rawText: _rt,
      creationDate: _cd,
      ...extractedItemMeta
    } = extractedMetadata;

    const contentExtractedTitle = cleanPdfTitle(
      extractedMetadata.title,
      undefined,
      extractedMetadata.authors,
      extractedMetadata.creators,
    );
    const hasExtractedTitle =
      Boolean(contentExtractedTitle) &&
      contentExtractedTitle !== 'Uploaded Document';

    const resolvedTitle = hasExtractedTitle
      ? contentExtractedTitle
      : cleanPdfTitle(
          extractedMetadata.title,
          payload.filename,
          extractedMetadata.authors,
          extractedMetadata.creators,
        );
    const isFilenameTitle = !hasExtractedTitle;

    const hasAuthoritativeId = Boolean(
      extractedMetadata.doi ||
      filenameDoi ||
      extractedMetadata.arxivId ||
      filenameArxivId ||
      extractedMetadata.isbn ||
      extractedMetadata.pmid,
    );

    let inferredItemType: string | undefined;
    let inferredConfidence = 0.75;

    if (!extractedMetadata.itemType) {
      const inferred = inferItemTypeFromPdfSignals({
        title: resolvedTitle,
        notes: extractedMetadata.notes,
        journal: extractedMetadata.journal,
        conferenceName: extractedMetadata.conferenceName,
        bookTitle: extractedMetadata.bookTitle,
        isbn: extractedMetadata.isbn,
        publisher: extractedMetadata.publisher,
        filename: payload.filename,
      });

      if (inferred) {
        inferredItemType = inferred.itemType;
        if (!hasAuthoritativeId) {
          inferredConfidence = 0.75 * inferred.confidence;
        }
      }
    }

    // Zero-guesswork abstract policy (Zotero-style):
    // Abstracts must come from authoritative registries, structured authoring XMP metadata,
    // or credible local extraction (matching ExtractionMetadataSynchronizer's high-confidence policy).
    const isUnindexed = !hasAuthoritativeId;
    const rawAbstract =
      typeof extractedMetadata.abstract === 'string'
        ? extractedMetadata.abstract.trim()
        : '';
    const hasCredibleLocalAbstract =
      rawAbstract.length >= 80 &&
      (typeof extractedMetadata.qualityScore === 'number'
        ? extractedMetadata.qualityScore >= 0.6
        : true);
    const resolvedAbstract =
      isUnindexed && !extractedMetadata.xmpFound && !hasCredibleLocalAbstract
        ? undefined
        : rawAbstract || undefined;

    const rawFileMetadata = {
      ...extractedItemMeta,
      doi: extractedMetadata.doi || filenameDoi,
      isbn: extractedMetadata.isbn,
      arxivId: extractedMetadata.arxivId || filenameArxivId,
      pmid: extractedMetadata.pmid,
      title: resolvedTitle,
      itemType: inferredItemType ?? extractedMetadata.itemType,
      authors: extractedMetadata.authors?.length
        ? extractedMetadata.authors
        : undefined,
      creators: extractedMetadata.creators?.length
        ? extractedMetadata.creators
        : undefined,
      year: extractedMetadata.year || undefined,
      publicationDate:
        extractedMetadata.publicationDate ||
        (extractedMetadata.year ? String(extractedMetadata.year) : undefined),
      abstract: resolvedAbstract,
      publisher: extractedMetadata.publisher,
      publicationTitle:
        extractedMetadata.publicationTitle || extractedMetadata.journal,
      journal: extractedMetadata.journal,
      pages: extractedMetadata.pages || undefined,
      tags: extractedMetadata.tags || extractedMetadata.keywords,
      fileId: payload.fileId,
      filename: payload.filename,
      referenceCount: extractedMetadata.referenceCount,
      citationCount: extractedMetadata.citationCount,
      notes: Array.isArray(extractedMetadata.notes)
        ? extractedMetadata.notes.map((n) => ({
            content: typeof n === 'string' ? n : n.content || '',
            source: 'pdf_extractor',
          }))
        : undefined,
      extraFields: {
        ...(extractedMetadata.extraFields || {}),
        ...(isUnindexed ? { isUnindexed: true } : {}),
        ...(isFilenameTitle ? { isFilenameTitle: true } : {}),
        ...(extractedMetadata.numberOfPages
          ? {
              numberOfPages: extractedMetadata.numberOfPages,
              numPages: extractedMetadata.numberOfPages,
            }
          : {}),
        ...(extractedMetadata.isSelfSufficient !== undefined
          ? {
              isSelfSufficient: extractedMetadata.isSelfSufficient,
              qualityScore: extractedMetadata.qualityScore,
              engineUsed: extractedMetadata.engineUsed,
            }
          : {}),
      },
      isSelfSufficient: extractedMetadata.isSelfSufficient,
      qualityScore: extractedMetadata.qualityScore,
      engineUsed: extractedMetadata.engineUsed,
    };

    const isSelfSufficient = extractedMetadata.isSelfSufficient === true;
    const candidateSourceName = isSelfSufficient
      ? 'TrustedPaper'
      : 'StagedPdf';

    const candidateConfidence = isSelfSufficient
      ? extractedMetadata.qualityScore || 0.85
      : extractedMetadata.doi || filenameDoi
        ? 0.9
        : extractedMetadata.arxivId || filenameArxivId
          ? 0.88
          : extractedMetadata.isbn
            ? 0.85
            : inferredConfidence;

    const fieldOverrides = isFilenameTitle
      ? {
          title: {
            path: 'title',
            value: resolvedTitle,
            normalizedValue: resolvedTitle,
            confidence: 0.25,
            sourceProvider: 'StagedPdf',
            retrievedAt: new Date().toISOString(),
          },
        }
      : undefined;

    return createCandidate({
      sourceKind: 'FILE',
      sourceName: candidateSourceName,
      sourceRecordId: payload.fileId,
      rawMetadata: rawFileMetadata,
      confidenceScore: candidateConfidence,
      fieldOverrides,
      normalizer: this.normalizer,
    });
  }
}
