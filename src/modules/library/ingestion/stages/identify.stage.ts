import {
  Injectable,
  Logger,
  Inject,
  Optional,
  BadRequestException,
} from '@nestjs/common';
import zlib from 'zlib';
import { promisify } from 'util';
import { randomUUID } from 'crypto';

const gunzipAsync = promisify(zlib.gunzip);
import { SubmissionPayload } from '@/modules/library/ingestion/types/submission.types';
import {
  MetadataCandidate,
  FieldEvidence,
} from '@/modules/library/ingestion/types/metadata-candidate.types';
import {
  DoiParser,
  BibtexParser,
  RisParser,
  CslParser,
  QueryClassifier,
  ParsedBibtexEntry,
} from '@/modules/library/ingestion/parsers';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import {
  normalizeAcademicTitleCase,
  inferItemTypeFromPdfSignals,
} from '@/modules/library/shared-kernel/domain/academic-text.domain';
import {
  normalizeArxivId,
  normalizePmid,
  normalizeIsbn,
  deriveDoiFromPublisherUrl,
} from '@/modules/library/shared-kernel/domain/identifier.domain';
import { UrlMetadataScraperService } from '@/modules/library/ingestion/services/url-metadata-scraper.service';
import {
  EXTRACTION_GATEWAY_PORT,
  IExtractionGatewayPort,
} from '@/modules/library/ingestion/types/extraction-gateway.types';
import {
  IWorkflowStage,
  IdentifyStageInput,
} from '@/modules/library/ingestion/types/workflow-stage.types';

interface ExtractedPdfMetadata {
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

@Injectable()
export class IdentifyStage implements IWorkflowStage<
  IdentifyStageInput | string,
  MetadataCandidate[]
> {
  readonly stageName = 'IDENTIFY' as const;
  private readonly logger = new Logger(IdentifyStage.name);

  constructor(
    private readonly doiParser: DoiParser,
    private readonly bibtexParser: BibtexParser,
    private readonly risParser: RisParser,
    private readonly normalizer: NormalizationPolicy,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional()
    @Inject(EXTRACTION_GATEWAY_PORT)
    private readonly extractionGateway?: IExtractionGatewayPort,
    @Optional() private readonly urlScraper?: UrlMetadataScraperService,
    @Optional() private readonly cslParser: CslParser = new CslParser(),
  ) {}

  /**
   * Executes identification and initial format translation into candidate envelopes.
   */
  async execute(
    runIdOrInput: string | IdentifyStageInput,
    payloadArg?: SubmissionPayload,
    scopeIdArg?: string,
  ): Promise<MetadataCandidate[]> {
    const _runId =
      typeof runIdOrInput === 'string' ? runIdOrInput : runIdOrInput.runId;
    const payload =
      typeof runIdOrInput === 'string' ? payloadArg! : runIdOrInput.payload;
    const scopeId =
      typeof runIdOrInput === 'string' ? scopeIdArg : runIdOrInput.scopeId;
    const candidates: MetadataCandidate[] = [];

    switch (payload.kind) {
      case 'IDENTIFIER': {
        const candidate = this.buildIdentifierCandidate(
          payload.identifierType,
          payload.value,
        );
        if (candidate) candidates.push(candidate);
        break;
      }

      case 'RECORD': {
        const recordContent = await this.resolveRecordContent(payload);
        const format = (payload.format || '').toUpperCase();

        if (format === 'BIBTEX') {
          const parsedList = this.bibtexParser.parse(recordContent);
          for (const item of parsedList) {
            candidates.push(
              this.createCandidate({
                sourceKind: 'RECORD',
                sourceName: 'BibTeX',
                sourceRecordId: item.citationKey || item.doi,
                rawMetadata: this.mapBibtexToRaw(item),
                confidenceScore: 0.95,
              }),
            );
          }
        } else if (format === 'RIS') {
          const parsedList = this.risParser.parse(recordContent);
          for (const item of parsedList) {
            candidates.push(
              this.createCandidate({
                sourceKind: 'RECORD',
                sourceName: 'RIS',
                sourceRecordId: item.doi || item.citationKey,
                rawMetadata: item,
                confidenceScore: 0.95,
              }),
            );
          }
        } else if (
          format === 'CSL_JSON' ||
          format === 'JSON' ||
          (payload.format as string) === 'csl_json'
        ) {
          const parsedList = this.cslParser.parse(recordContent);
          for (const item of parsedList) {
            candidates.push(
              this.createCandidate({
                sourceKind: 'RECORD',
                sourceName: 'CSL_JSON',
                sourceRecordId: item.citationKey || item.doi,
                rawMetadata: item,
                confidenceScore: 0.95,
              }),
            );
          }
        } else if (
          format === 'ENDNOTE_XML' ||
          format === 'MODS' ||
          format === 'REFER'
        ) {
          const parsedList = await this.risParser.parseAsync(recordContent);
          for (const item of parsedList) {
            candidates.push(
              this.createCandidate({
                sourceKind: 'RECORD',
                sourceName: payload.format,
                sourceRecordId: item.doi || item.citationKey,
                rawMetadata: item,
                confidenceScore: 0.9,
              }),
            );
          }
        }
        break;
      }

      case 'URL': {
        const candidate = await this.resolveUrlCandidate(payload, scopeId);
        if (candidate) candidates.push(candidate);
        break;
      }

      case 'FILE': {
        const candidate = await this.resolveFileCandidate(payload, scopeId);
        if (candidate) candidates.push(candidate);
        break;
      }
    }

    return candidates;
  }

  // ── Helper Resolvers ───────────────────────────────────────────────────────

  private buildIdentifierCandidate(
    type: string,
    rawValue: string,
  ): MetadataCandidate | null {
    let fieldKey: 'doi' | 'arxivId' | 'pmid' | 'isbn';
    let cleanValue = rawValue;

    if (type === 'DOI') {
      fieldKey = 'doi';
      cleanValue = this.doiParser.normalize(rawValue);
    } else if (type === 'ARXIV') {
      fieldKey = 'arxivId';
      cleanValue =
        normalizeArxivId(rawValue) ||
        rawValue.replace(/^arxiv:\s*/i, '').trim();
    } else if (type === 'PMID') {
      fieldKey = 'pmid';
      cleanValue =
        normalizePmid(rawValue) || rawValue.replace(/^pmid:\s*/i, '').trim();
    } else if (type === 'ISBN') {
      fieldKey = 'isbn';
      cleanValue =
        normalizeIsbn(rawValue) ||
        rawValue
          .replace(/[-\s]/g, '')
          .replace(/^isbn:?\s*/i, '')
          .trim();
    } else {
      return null;
    }

    const rawMetadata = { [fieldKey]: rawValue };
    const normalizedMetadata = this.normalizer.normalize({
      [fieldKey]: cleanValue,
    });

    return this.createCandidate({
      sourceKind: 'IDENTIFIER',
      sourceName: 'DirectIdentifier',
      sourceRecordId: cleanValue,
      rawMetadata,
      normalizedMetadata,
      confidenceScore: 1.0,
      fieldOverrides: {
        [fieldKey]: {
          path: fieldKey,
          value: rawValue,
          normalizedValue: cleanValue,
          confidence: 1.0,
          sourceProvider: 'UserIdentifier',
          retrievedAt: new Date().toISOString(),
        },
      },
    });
  }

  private async resolveRecordContent(
    payload: SubmissionPayload & { kind: 'RECORD' },
  ): Promise<string> {
    let content = payload.content || '';
    if (
      payload.isOffloaded &&
      payload.fileId &&
      typeof this.storagePort?.readOwnedFile === 'function'
    ) {
      try {
        const file = await this.storagePort.readOwnedFile({
          fileId: payload.fileId,
        });
        if (file?.buffer) {
          const decompressed = await gunzipAsync(file.buffer);
          content = decompressed.toString('utf-8');
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `[ClaimCheck] Failed to hydrate offloaded record payload ${payload.fileId}: ${message}`,
        );
        throw new BadRequestException(
          `Failed to hydrate offloaded record content: ${message}`,
        );
      }
    }
    return content;
  }

  private async resolveUrlCandidate(
    payload: SubmissionPayload & { kind: 'URL' },
    scopeId?: string,
  ): Promise<MetadataCandidate> {
    const classified = QueryClassifier.classify(payload.url);
    let extractedRaw: Record<string, unknown> = { url: payload.url };

    if (classified.type === 'DOI') extractedRaw.doi = classified.clean;
    else if (classified.type === 'ARXIV')
      extractedRaw.arxivId = classified.clean;
    else if (classified.type === 'PMID') extractedRaw.pmid = classified.clean;
    else if (classified.type === 'ISBN') extractedRaw.isbn = classified.clean;

    if (!extractedRaw.doi && !extractedRaw.arxivId && !extractedRaw.pmid) {
      const urlDoi = deriveDoiFromPublisherUrl(payload.url);
      if (urlDoi) extractedRaw.doi = urlDoi;
    }

    const hasDirectIdentifier = Boolean(
      extractedRaw.doi || extractedRaw.arxivId || extractedRaw.pmid,
    );

    // Zotero-style: Only scrape HTML if the URL lacks an embedded identifier
    if (!hasDirectIdentifier && this.urlScraper) {
      try {
        const scraped = await this.urlScraper.scrape(payload.url, {
          scopeId,
          preferredFilename: payload.filename,
        });

        extractedRaw = {
          ...extractedRaw,
          ...scraped,
          url: payload.url,
          filename: scraped.filename || payload.filename,
          fileUrl: scraped.pdfUrl || (scraped.isPdf ? payload.url : undefined),
        };
      } catch (scrapeErr: unknown) {
        const message =
          scrapeErr instanceof Error ? scrapeErr.message : String(scrapeErr);
        this.logger.warn(
          `UrlMetadataScraper error for "${payload.url}": ${message}`,
        );
      }
    }

    const normalized = this.normalizer.normalize(extractedRaw);
    if (typeof extractedRaw.fileId === 'string')
      normalized.fileId = extractedRaw.fileId;
    if (typeof extractedRaw.filename === 'string')
      normalized.filename = extractedRaw.filename;
    if (typeof extractedRaw.fileUrl === 'string')
      normalized.fileUrl = extractedRaw.fileUrl;
    if (
      !normalized.fileUrl &&
      typeof payload.url === 'string' &&
      /\.pdf(?:$|\?)/i.test(payload.url)
    ) {
      normalized.fileUrl = payload.url;
    }

    const hasIdentifier = Boolean(
      normalized.doi || normalized.arxivId || normalized.pmid,
    );
    const hasTitle = Boolean(
      normalized.title && normalized.title !== 'Untitled Document',
    );

    if (extractedRaw.isBlocked && !hasIdentifier) {
      normalized.extraFields = {
        ...(normalized.extraFields || {}),
        isBlocked: true,
        wafKind: extractedRaw.wafKind,
        promptUploadPdf: true,
        ladderStepReached: extractedRaw.ladderStepReached,
      };
    }

    const confidenceScore = hasIdentifier
      ? 1.0
      : extractedRaw.isBlocked
        ? 0.2
        : hasTitle
          ? 0.88
          : 0.7;

    const sourceKind = hasIdentifier ? 'IDENTIFIER' : 'URL';
    const sourceName = hasIdentifier ? 'DirectIdentifier' : 'UrlCapture';
    const sourceRecordId = hasIdentifier
      ? normalized.doi || normalized.arxivId || normalized.pmid || payload.url
      : payload.url;

    return this.createCandidate({
      sourceKind,
      sourceName,
      sourceRecordId,
      rawMetadata: extractedRaw,
      normalizedMetadata: normalized,
      confidenceScore,
    });
  }

  private async resolveFileCandidate(
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
            extractedMetadata =
              extractedDoc?.metadata ||
              (extractedDoc as Record<string, unknown>) ||
              {};
          }

          if (
            Object.keys(extractedMetadata).length === 0 &&
            this.extractionGateway.extractMetadataFromBuffer
          ) {
            extractedMetadata =
              (await this.extractionGateway.extractMetadataFromBuffer<
                Record<string, unknown>
              >(fileRecord.buffer)) || {};
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

    const resolvedTitle = this.cleanPdfTitle(
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

    return this.createCandidate({
      sourceKind: 'FILE',
      sourceName: candidateSourceName,
      sourceRecordId: payload.fileId,
      rawMetadata: rawFileMetadata,
      confidenceScore: candidateConfidence,
    });
  }

  private cleanPdfTitle(
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
        /^\d{4}\s*\d{4,5}(v\d+)?$/i.test(cleanBase) ||
        /^arxiv/i.test(cleanBase);
      if (cleanBase.length > 2 && !isArxivPattern) {
        return normalizeAcademicTitleCase(cleanBase);
      }
    }

    return 'Uploaded Document';
  }

  private mapBibtexToRaw(
    item: ParsedBibtexEntry | Record<string, unknown>,
  ): Record<string, unknown> {
    const extraFields: Record<string, unknown> = {
      ...(typeof item.extraFields === 'object' && item.extraFields !== null
        ? (item.extraFields as Record<string, unknown>)
        : {}),
      ...(item.university ? { university: item.university } : {}),
      ...(item.institution ? { institution: item.institution } : {}),
      ...(item.thesisType ? { thesisType: item.thesisType } : {}),
      ...(item.reportNumber ? { reportNumber: item.reportNumber } : {}),
      ...(item.reportType ? { reportType: item.reportType } : {}),
      ...(item.bookTitle ? { bookTitle: item.bookTitle } : {}),
      ...(item.proceedingsTitle
        ? { proceedingsTitle: item.proceedingsTitle }
        : {}),
      ...(item.conferenceName ? { conferenceName: item.conferenceName } : {}),
      ...(item.eventPlace ? { eventPlace: item.eventPlace } : {}),
      ...(item.numPages
        ? {
            numPages: Number(item.numPages) || item.numPages,
            numberOfPages: Number(item.numPages) || item.numPages,
          }
        : {}),
      ...(item.numberOfVolumes
        ? { numberOfVolumes: item.numberOfVolumes }
        : {}),
      ...(item.seriesNumber ? { seriesNumber: item.seriesNumber } : {}),
      ...(item.chapter ? { chapter: item.chapter } : {}),
    };

    return {
      title: item.title,
      shortTitle: item.shortTitle,
      itemType: item.itemType,
      authors: item.authors,
      editors: item.editors,
      creators: item.creators,
      year: item.year,
      publicationDate: item.publicationDate,
      publicationTitle: item.journal || item.proceedingsTitle || item.bookTitle,
      journal: item.journal,
      journalAbbr: item.journalAbbr,
      publisher: item.publisher || item.university || item.institution,
      university: item.university,
      institution: item.institution,
      thesisType: item.thesisType,
      reportNumber: item.reportNumber,
      reportType: item.reportType,
      bookTitle: item.bookTitle,
      proceedingsTitle: item.proceedingsTitle,
      conferenceName: item.conferenceName,
      eventPlace: item.eventPlace,
      place: item.place,
      volume: item.volume,
      issue: item.issue,
      pages: item.pages,
      numPages: item.numPages,
      numberOfPages: item.numPages
        ? Number(item.numPages) || undefined
        : undefined,
      numberOfVolumes: item.numberOfVolumes,
      series: item.series,
      seriesNumber: item.seriesNumber,
      chapter: item.chapter,
      edition: item.edition,
      arxivId: item.arxivId,
      doi: item.doi,
      pmid: item.pmid,
      pmcid: item.pmcid,
      isbn: item.isbn,
      issn: item.issn,
      url: item.url,
      accessedAt: item.accessedAt,
      abstract: item.abstract,
      citationKey: item.citationKey,
      tags: item.keywords,
      keywords: item.keywords,
      notes: Array.isArray(item.notes)
        ? (item.notes as string[]).map((n: string) => ({
            content: n,
            source: 'bibtex',
          }))
        : undefined,
      language: item.language,
      rights: item.rights,
      fileUrl: item.fileUrl,
      extra: item.extra,
      extraFields:
        Object.keys(extraFields).length > 0 ? extraFields : undefined,
      seeAlso: item.seeAlso,
      relations: item.relations,
    };
  }

  private createCandidate(params: {
    sourceKind: MetadataCandidate['sourceKind'];
    sourceName: string;
    sourceRecordId?: string;
    rawMetadata: Record<string, unknown>;
    normalizedMetadata?: Record<string, unknown>;
    confidenceScore: number;
    fieldOverrides?: Record<string, FieldEvidence>;
  }): MetadataCandidate {
    const normalized =
      params.normalizedMetadata ??
      this.normalizer.normalize(params.rawMetadata);

    return {
      candidateId: randomUUID(),
      sourceKind: params.sourceKind,
      sourceName: params.sourceName,
      sourceRecordId: params.sourceRecordId,
      retrievedAt: new Date().toISOString(),
      schemaVersion: '1.0.0',
      fields: {
        ...this.buildEvidenceFields(
          params.rawMetadata,
          normalized,
          params.sourceName,
        ),
        ...(params.fieldOverrides || {}),
      },
      normalizedMetadata: normalized,
      confidenceScore: params.confidenceScore,
    };
  }

  private buildEvidenceFields(
    rawMetadata: Record<string, unknown>,
    normalizedMetadata: Record<string, unknown>,
    sourceName: string,
  ): Record<string, FieldEvidence> {
    const fields: Record<string, FieldEvidence> = {};
    for (const fieldName of Object.keys(normalizedMetadata)) {
      if (
        normalizedMetadata[fieldName] !== undefined &&
        normalizedMetadata[fieldName] !== null
      ) {
        fields[fieldName] = {
          path: fieldName,
          value: rawMetadata[fieldName],
          normalizedValue: normalizedMetadata[fieldName],
          confidence: 0.95,
          sourceProvider: sourceName,
          retrievedAt: new Date().toISOString(),
        };
      }
    }
    return fields;
  }
}
