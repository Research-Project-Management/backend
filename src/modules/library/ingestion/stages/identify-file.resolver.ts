import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import {
  EXTRACTION_FACADE,
  IExtractionFacade,
  normalizeAcademicTitleCase,
  inferItemTypeFromPdfSignals,
} from '@/modules/library/core';
import { SubmissionPayload } from '@/modules/library/ingestion/types/submission.types';
import { MetadataCandidate } from '@/modules/library/ingestion/types/metadata-candidate.types';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import { createCandidate } from './candidate-builder.helper';

export interface ExtractedPdfMetadata {
  title?: string;
  authors?: Array<
    | string
    | {
        fullName?: string;
        name?: string;
        firstName?: string;
        lastName?: string;
      }
  >;
  creators?: Array<
    | string
    | {
        fullName?: string;
        name?: string;
        firstName?: string;
        lastName?: string;
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

export function cleanPdfTitle(
  rawTitle?: unknown,
  filename?: string,
  authors?: unknown[],
  creators?: unknown[],
): string {
  if (typeof rawTitle === 'string') {
    let t = rawTitle.trim();
    const isBannerOrGarbage =
      /noname\s+manuscript/i.test(t) ||
      /\(will\s+be\s+inserted\s+by\s+the\s+editor\)/i.test(t) ||
      /proceedings\s+of\s+the/i.test(t) ||
      /submitted\s+(to|\d)/i.test(t) ||
      /published\s+\d/i.test(t) ||
      /^journal\s+of\s+/i.test(t) ||
      /\.(eps|pdf|png|jpe?g|svg)$/i.test(t) ||
      /^(untitled|document|microsoft word)/i.test(t) ||
      /^[A-Z]\s+[A-Z]\s+[A-Z]\s+[A-Z]/i.test(t);

    if (t.length > 3 && !isBannerOrGarbage) {
      t = t.replace(/[\s∗*†‡§#]+$/, '').trim();
      const firstLine = t.split(/\r?\n/)[0]?.trim();
      if (firstLine && firstLine.length > 5 && firstLine.length < t.length) {
        t = firstLine;
      }

      const candidateAuthors = [
        ...(Array.isArray(authors) ? authors : []),
        ...(Array.isArray(creators) ? creators : []),
      ];
      for (const author of candidateAuthors) {
        const authorObj =
          typeof author === 'object' && author !== null
            ? (author as {
                fullName?: string;
                name?: string;
                firstName?: string;
                lastName?: string;
              })
            : null;
        const authorStr =
          typeof author === 'string'
            ? author
            : (
                authorObj?.fullName ||
                authorObj?.name ||
                `${authorObj?.firstName || ''} ${authorObj?.lastName || ''}`
              ).trim();
        if (authorStr && authorStr.length > 3) {
          const escaped = authorStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          t = t
            .replace(new RegExp(`\\s+${escaped}[\\s∗*†‡§#]*$`, 'i'), '')
            .trim();
        }
      }
      return normalizeAcademicTitleCase(t);
    }
  }

  if (filename) {
    const cleanBase = filename
      .replace(/\.[a-zA-Z0-9]+$/, '')
      .replace(/[-_]+/g, ' ')
      .trim();
    const isArxivPattern =
      /^\d{4}\s*\d{4,5}(v\d+)?$/i.test(cleanBase) || /^arxiv/i.test(cleanBase);
    if (cleanBase.length > 2 && !isArxivPattern) {
      return normalizeAcademicTitleCase(cleanBase);
    }
  }

  return 'Uploaded Document';
}

@Injectable()
export class IdentifyFileResolver {
  private readonly logger = new Logger(IdentifyFileResolver.name);

  constructor(
    private readonly normalizer: NormalizationPolicy,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional()
    @Inject(EXTRACTION_FACADE)
    private readonly extractionGateway?: IExtractionFacade,
  ) {}

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
    scopeId?: string,
  ): Promise<MetadataCandidate> {
    let extractedMetadata: ExtractedPdfMetadata = {};
    let fileBuffer: Buffer | undefined;

    const rawFilenameDoi = payload.filename?.match(
      /10\.\d{4,9}[/_@][-._;()/:A-Za-z0-9]+/,
    )?.[0];
    const filenameDoi = rawFilenameDoi
      ? rawFilenameDoi
          .replace(/^(10\.\d{4,9})[_@]/, '$1/')
          .replace(/[.,;:)\]]+$/, '')
      : undefined;

    const filenameArxivId = payload.filename?.match(
      /(?:arxiv[:_.-]*)?([0-2]\d{3}\.\d{4,5}(?:v\d+)?)/i,
    )?.[1];

    if (
      this.storagePort?.readOwnedFile &&
      this.extractionGateway?.extractDocumentFromBuffer &&
      payload.fileId
    ) {
      try {
        const fileRecord = await this.storagePort.readOwnedFile({
          fileId: payload.fileId,
          projectId: scopeId && scopeId !== 'user' ? scopeId : undefined,
        });
        if (fileRecord?.buffer) {
          fileBuffer = fileRecord.buffer;

          if (this.extractionGateway?.extractTrustedMetadata) {
            try {
              const trusted =
                await this.extractionGateway.extractTrustedMetadata<{
                  metadata?: Record<string, unknown>;
                  isSelfSufficient?: boolean;
                  quality?: { totalScore?: number };
                  provenance?: { engineUsed?: string };
                }>(fileRecord.buffer, payload.filename);
              if (trusted?.metadata) {
                extractedMetadata = {
                  ...trusted.metadata,
                  isSelfSufficient: trusted.isSelfSufficient,
                  qualityScore: trusted.quality?.totalScore,
                  engineUsed: trusted.provenance?.engineUsed,
                };
              }
            } catch {
              // Fall through to extractDocumentFromBuffer
            }
          }

          if (
            Object.keys(extractedMetadata).length === 0 &&
            this.extractionGateway?.extractDocumentFromBuffer
          ) {
            const extractedDoc =
              await this.extractionGateway.extractDocumentFromBuffer<{
                metadata?: Record<string, unknown>;
              }>(fileRecord.buffer, { headerOnly: true, maxPages: 3 });
            extractedMetadata = extractedDoc?.metadata || extractedDoc || {};
          }

          if (
            Object.keys(extractedMetadata).length === 0 &&
            this.extractionGateway.extractMetadataFromBuffer
          ) {
            extractedMetadata =
              this.extractionGateway.extractMetadataFromBuffer<
                Record<string, unknown>
              >(fileRecord.buffer) || {};
          }
        }
      } catch (caughtError: unknown) {
        this.logger.warn(
          `PDF metadata extraction failed for file ${payload.fileId}: ${caughtError instanceof Error ? caughtError.message : String(caughtError)}`,
        );
        try {
          extractedMetadata =
            fileBuffer && this.extractionGateway?.extractMetadataFromBuffer
              ? (await this.extractionGateway.extractMetadataFromBuffer(
                  fileBuffer,
                )) || {}
              : {};
        } catch {
          extractedMetadata = {};
        }
      }
    }

    const {
      rawText: _rt,
      creationDate: _cd,
      ...extractedItemMeta
    } = extractedMetadata;

    const resolvedTitle = cleanPdfTitle(
      extractedMetadata.title,
      payload.filename,
      extractedMetadata.authors,
      extractedMetadata.creators,
    );

    const hasAuthoritativeId = Boolean(
      extractedMetadata.doi ||
      filenameDoi ||
      extractedMetadata.arxivId ||
      filenameArxivId ||
      extractedMetadata.isbn,
    );

    let inferredItemType: string | undefined;
    let inferredConfidence = 0.75;

    if (!hasAuthoritativeId) {
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
        inferredConfidence = 0.75 * inferred.confidence;
      }
    }

    const rawFileMetadata = {
      ...extractedItemMeta,
      doi: extractedMetadata.doi || filenameDoi,
      isbn: extractedMetadata.isbn,
      arxivId: extractedMetadata.arxivId || filenameArxivId,
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
      abstract: extractedMetadata.abstract || undefined,
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
    const candidateSourceName = isSelfSufficient ? 'TrustedPaper' : 'StagedPdf';

    const candidateConfidence = isSelfSufficient
      ? extractedMetadata.qualityScore || 0.95
      : extractedMetadata.doi
        ? 0.95
        : extractedMetadata.arxivId
          ? 0.92
          : extractedMetadata.isbn
            ? 0.9
            : inferredConfidence;

    return createCandidate({
      sourceKind: 'FILE',
      sourceName: candidateSourceName,
      sourceRecordId: payload.fileId,
      rawMetadata: rawFileMetadata,
      confidenceScore: candidateConfidence,
      normalizer: this.normalizer,
    });
  }
}
