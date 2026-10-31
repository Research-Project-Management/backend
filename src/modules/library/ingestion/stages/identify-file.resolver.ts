import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import {
  EXTRACTION_FACADE,
  IExtractionFacade,
  normalizeAcademicTitleCase,
  inferItemTypeFromPdfSignals,
} from '@/modules/library/core';
import { SubmissionPayload } from '@/modules/library/ingestion/types/ingestion.types';
import { MetadataCandidate } from '@/modules/library/ingestion/types/metadata.types';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import { createCandidate } from '../domain/candidate-builder.helper';

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
    const clientPreResolved = (rawPayloadAny.preResolvedMetadata ||
      rawOverrides.preResolvedMetadata) as Record<string, unknown> | undefined;
    const isClientResolved =
      rawPayloadAny.resolutionSource === 'client' ||
      rawOverrides.resolutionSource === 'client' ||
      Boolean(clientPreResolved);

    if (clientPreResolved && typeof clientPreResolved === 'object') {
      extractedMetadata = {
        ...extractedMetadata,
        ...clientPreResolved,
        isSelfSufficient: true,
        qualityScore: 0.95,
        extraFields: {
          ...((clientPreResolved.extraFields as Record<string, unknown>) || {}),
          resolutionSource: 'client',
        },
      };
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

          let ranTrustedExtraction = false;
          if (this.extractionGateway?.extractTrustedMetadata) {
            try {
              const trusted =
                await this.extractionGateway.extractTrustedMetadata(
                  fileRecord.buffer,
                  payload.filename,
                );
              ranTrustedExtraction = true;
              if (trusted?.metadata) {
                extractedMetadata = {
                  ...(trusted.metadata as unknown as ExtractedPdfMetadata),
                  isSelfSufficient: trusted.isSelfSufficient,
                  qualityScore: trusted.quality?.totalScore,
                  engineUsed: trusted.provenance?.engineUsed,
                };
              }
            } catch {
              // Fall through to extractDocumentFromBuffer
            }
          }

          const needsDocumentFallback =
            Object.keys(extractedMetadata).length === 0 ||
            (!extractedMetadata.isSelfSufficient &&
              !extractedMetadata.doi &&
              !extractedMetadata.arxivId &&
              !extractedMetadata.isbn &&
              (!extractedMetadata.title ||
                extractedMetadata.title === 'Uploaded Document'));

          if (
            needsDocumentFallback &&
            this.extractionGateway?.extractDocumentFromBuffer
          ) {
            const extractedDoc =
              await this.extractionGateway.extractDocumentFromBuffer(
                fileRecord.buffer,
                {
                  headerOnly: true,
                  maxPages: 3,
                  ...(ranTrustedExtraction
                    ? { skipTrustedExtraction: true }
                    : {}),
                },
              );
            const docMeta =
              ((extractedDoc?.metadata ||
                extractedDoc) as unknown as ExtractedPdfMetadata) || {};
            if (Object.keys(extractedMetadata).length === 0) {
              extractedMetadata = docMeta;
            } else {
              extractedMetadata = {
                ...extractedMetadata,
                ...Object.fromEntries(
                  Object.entries(docMeta).filter(
                    ([, v]) => v !== undefined && v !== null && v !== '',
                  ),
                ),
              };
            }
          }

          if (
            Object.keys(extractedMetadata).length === 0 &&
            this.extractionGateway.extractMetadataFromBuffer
          ) {
            extractedMetadata =
              (this.extractionGateway.extractMetadataFromBuffer(
                fileRecord.buffer,
              ) as unknown as ExtractedPdfMetadata) || {};
          }
        }
      } catch (caughtError: unknown) {
        this.logger.warn(
          `PDF metadata extraction failed for file ${payload.fileId}: ${caughtError instanceof Error ? caughtError.message : String(caughtError)}`,
        );
        try {
          extractedMetadata =
            fileBuffer && this.extractionGateway?.extractMetadataFromBuffer
              ? (this.extractionGateway.extractMetadataFromBuffer(
                  fileBuffer,
                ) as unknown as ExtractedPdfMetadata) || {}
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

    // Zero-guesswork abstract policy (Zotero-style):
    // Abstracts must come from authoritative registries or structured authoring XMP metadata.
    // Unindexed PDFs without authoritative IDs must not have abstracts populated from arbitrary layout text regex slicing.
    const isUnindexed = !hasAuthoritativeId && !isClientResolved;
    const resolvedAbstract =
      isUnindexed && !extractedMetadata.xmpFound
        ? undefined
        : extractedMetadata.abstract || undefined;

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
    const candidateSourceName = isClientResolved
      ? 'ClientResolved'
      : isSelfSufficient
        ? 'TrustedPaper'
        : 'StagedPdf';

    const candidateConfidence = isClientResolved
      ? 0.95
      : isSelfSufficient
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
