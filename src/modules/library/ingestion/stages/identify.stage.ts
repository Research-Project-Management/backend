import {
  Injectable,
  Logger,
  Inject,
  Optional,
  BadRequestException,
} from '@nestjs/common';
import {
  SubmissionPayload,
  RecordFormat,
  SubmissionKind,
  IdentifierType,
  IWorkflowStage,
  IdentifyStageInput,
} from '@/modules/library/ingestion/types/ingestion.types';
import {
  MetadataCandidate,
  FieldEvidence,
} from '@/modules/library/ingestion/types/metadata.types';
import {
  BibtexParser,
  ParsedBibtexEntry,
  DoiParser,
  QueryClassifier,
} from '@/modules/library/ingestion/parsers/bibtex.parser';
import { RisParser } from '@/modules/library/ingestion/parsers/ris.parser';
import { CslParser } from '@/modules/library/ingestion/parsers/csl.parser';
import { XmlLegacyFormatsParser } from '@/modules/library/ingestion/parsers/xml-legacy-formats.parser';
import { BibliographyFormatRegistry } from '@/modules/library/ingestion/parsers/bibliography-format.registry';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import {
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  deriveDoiFromPublisherUrl,
  gunzipAsync,
} from '@/modules/library/core';
import { UrlMetadataScraperService } from '@/modules/library/ingestion/services/url-metadata-scraper.service';
import {
  createCandidate,
  buildEvidenceFields,
  mapBibtexToRawRecord,
  applyUserOverridesToCandidate,
} from '../domain/candidate-builder.helper';
import { IdentifyFileResolver, cleanPdfTitle } from './identify-file.resolver';

export {
  type ExtractedPdfMetadata,
  cleanPdfTitle,
} from './identify-file.resolver';
export {
  createCandidate,
  buildEvidenceFields,
  mapBibtexToRawRecord,
  applyUserOverridesToCandidate,
} from '../domain/candidate-builder.helper';

@Injectable()
export class IdentifyUrlResolver {
  private readonly logger = new Logger(IdentifyUrlResolver.name);

  constructor(
    private readonly normalizer: NormalizationPolicy,
    @Optional() private readonly urlScraper?: UrlMetadataScraperService,
  ) {}

  async resolve(
    payload: SubmissionPayload & { kind: 'URL' },
    scopeId?: string,
    options?: { forceScrape?: boolean },
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

    if ((!hasDirectIdentifier || options?.forceScrape) && this.urlScraper) {
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
      ? (normalized.doi as string) ||
        (normalized.arxivId as string) ||
        (normalized.pmid as string) ||
        payload.url
      : payload.url;

    return createCandidate({
      sourceKind,
      sourceName,
      sourceRecordId,
      rawMetadata: extractedRaw,
      normalizedMetadata: normalized,
      confidenceScore,
      normalizer: this.normalizer,
    });
  }
}

type IdentifierCandidateApplier = (
  rawValue: string,
  doiParser: DoiParser,
) => { fieldKey: 'doi' | 'arxivId' | 'pmid' | 'isbn'; cleanValue: string };

export const IDENTIFIER_CANDIDATE_APPLIERS: Readonly<
  Record<IdentifierType, IdentifierCandidateApplier>
> = {
  DOI: (rawValue, doiParser) => ({
    fieldKey: 'doi',
    cleanValue: doiParser.normalize(rawValue),
  }),
  ARXIV: (rawValue) => ({
    fieldKey: 'arxivId',
    cleanValue:
      normalizeArxivId(rawValue) ||
      rawValue.replace(/^arxiv:\s*/i, '').trim(),
  }),
  PMID: (rawValue) => ({
    fieldKey: 'pmid',
    cleanValue:
      normalizePmcid(rawValue) ||
      normalizePmid(rawValue) ||
      rawValue.replace(/^(?:pmcid|pmc|pmid):\s*/i, '').trim(),
  }),
  ISBN: (rawValue) => ({
    fieldKey: 'isbn',
    cleanValue:
      normalizeIsbn(rawValue) ||
      rawValue
        .replace(/[-\s]/g, '')
        .replace(/^isbn:?\s*/i, '')
        .trim(),
  }),
};

interface IdentifyExecutionContext {
  scopeId?: string;
  userId?: string;
  projectId?: string;
}

type IdentifyPayloadStrategy<K extends SubmissionKind = SubmissionKind> = (
  stage: IdentifyStage,
  payload: Extract<SubmissionPayload, { kind: K }>,
  context: IdentifyExecutionContext,
) => Promise<MetadataCandidate[]>;

export const IDENTIFY_PAYLOAD_STRATEGIES: {
  readonly [K in SubmissionKind]: IdentifyPayloadStrategy<K>;
} = {
  IDENTIFIER: async (stage, payload) => {
    const candidate = stage.buildIdentifierCandidate(
      payload.identifierType,
      payload.value,
    );
    return candidate ? [candidate] : [];
  },
  RECORD: async (stage, payload, context) =>
    stage.identifyRecordPayload(payload, context),
  URL: async (stage, payload, context) => {
    const candidate = await stage.resolveUrlCandidate(payload, context.scopeId);
    return candidate ? [candidate] : [];
  },
  FILE: async (stage, payload, context) => {
    const candidate = await stage.resolveFileCandidate(
      payload,
      context.scopeId,
      context,
    );
    return candidate ? [candidate] : [];
  },
  CONNECTOR: async (stage, payload) => stage.identifyConnectorPayload(payload),
};

@Injectable()
export class IdentifyStage implements IWorkflowStage<
  IdentifyStageInput,
  MetadataCandidate[]
> {
  readonly stageName = 'IDENTIFY' as const;
  private readonly logger = new Logger(IdentifyStage.name);

  private readonly cslParser: CslParser;
  private readonly xmlLegacyParser: XmlLegacyFormatsParser;
  private readonly formatRegistry: BibliographyFormatRegistry;

  constructor(
    private readonly doiParser: DoiParser,
    private readonly bibtexParser: BibtexParser,
    private readonly risParser: RisParser,
    private readonly normalizer: NormalizationPolicy,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional()
    cslParser?: CslParser,
    @Optional()
    private readonly fileResolver?: IdentifyFileResolver,
    @Optional()
    private readonly urlResolver?: IdentifyUrlResolver,
    @Optional()
    xmlLegacyParser?: XmlLegacyFormatsParser,
    @Optional()
    formatRegistry?: BibliographyFormatRegistry,
  ) {
    this.cslParser = cslParser ?? new CslParser();
    this.xmlLegacyParser = xmlLegacyParser ?? new XmlLegacyFormatsParser();
    this.formatRegistry =
      formatRegistry ??
      new BibliographyFormatRegistry(
        this.bibtexParser,
        this.risParser,
        this.cslParser,
        this.xmlLegacyParser,
      );
  }

  detectRecordFormat(
    content: string,
    hintFormat?: string,
  ): RecordFormat | null {
    return this.formatRegistry.detectRecordFormat(content, hintFormat);
  }

  async execute(input: IdentifyStageInput): Promise<MetadataCandidate[]> {
    const { runId: _runId, payload, scopeId, userId, projectId } = input;
    const context: IdentifyExecutionContext = {
      scopeId,
      userId,
      projectId:
        projectId ??
        (scopeId && scopeId !== 'user' && scopeId !== userId
          ? scopeId
          : undefined),
    };

    const strategy = IDENTIFY_PAYLOAD_STRATEGIES[payload.kind] as
      | IdentifyPayloadStrategy
      | undefined;
    if (!strategy) return [];
    return strategy(this, payload, context);
  }

  async identifyRecordPayload(
    payload: SubmissionPayload & { kind: 'RECORD' },
    context: IdentifyExecutionContext,
  ): Promise<MetadataCandidate[]> {
    const recordContent = await this.resolveRecordContent(payload, context);
    const envelopes = await this.formatRegistry.parseEnvelopes(
      recordContent,
      payload.format,
    );
    return envelopes.map((env) =>
      this.createCandidate({
        sourceKind: 'RECORD',
        sourceName: env.sourceName,
        sourceRecordId: env.sourceRecordId,
        rawMetadata: env.rawMetadata,
        confidenceScore: env.confidenceScore,
      }),
    );
  }

  identifyConnectorPayload(
    payload: SubmissionPayload & { kind: 'CONNECTOR' },
  ): MetadataCandidate[] {
    const candidates: MetadataCandidate[] = [];
    const connectorRaw = payload as unknown as Record<string, unknown>;
    const inlineContent =
      typeof connectorRaw.content === 'string' ? connectorRaw.content : '';
    if (inlineContent.trim()) {
      const parsedList = this.bibtexParser.parse(inlineContent);
      for (const item of parsedList) {
        candidates.push(
          this.createCandidate({
            sourceKind: 'RECORD',
            sourceName: connectorRaw.connectionId
              ? `Connector:${String(connectorRaw.connectionId)}`
              : 'ZoteroConnector',
            sourceRecordId:
              item.citationKey ||
              item.doi ||
              payload.externalObjectId ||
              undefined,
            rawMetadata: this.mapBibtexToRaw(item),
            confidenceScore: 0.95,
          }),
        );
      }
    } else if (payload.externalObjectId) {
      const idCandidate =
        this.buildIdentifierCandidate('DOI', payload.externalObjectId) ||
        this.createCandidate({
          sourceKind: 'RECORD',
          sourceName: 'ZoteroConnector',
          sourceRecordId: payload.externalObjectId,
          rawMetadata: {
            title: `Zotero Item (${payload.externalObjectId})`,
            citationKey: payload.externalObjectId,
          },
          confidenceScore: 0.85,
        });
      if (idCandidate) candidates.push(idCandidate);
    }
    return candidates;
  }

  buildIdentifierCandidate(
    type: string,
    rawValue: string,
  ): MetadataCandidate | null {
    const applier = IDENTIFIER_CANDIDATE_APPLIERS[type as IdentifierType];
    if (!applier) return null;

    const { fieldKey, cleanValue } = applier(rawValue, this.doiParser);

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
    context?: { userId?: string; projectId?: string; scopeId?: string },
  ): Promise<string> {
    let content = payload.content || '';
    if (
      payload.isOffloaded &&
      payload.fileId &&
      this.storagePort?.readOwnedFile
    ) {
      try {
        const file = await this.storagePort.readOwnedFile({
          fileId: payload.fileId,
          ...(context?.userId ? { userId: context.userId } : {}),
          ...(context?.userId && context?.projectId
            ? { projectId: context.projectId }
            : {}),
        });
        if (file?.buffer) {
          const decompressed = await gunzipAsync(file.buffer, {
            maxOutputLength: 50 * 1024 * 1024,
          });
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

  async resolveUrlCandidate(
    payload: SubmissionPayload & { kind: 'URL' },
    scopeId?: string,
  ): Promise<MetadataCandidate | null> {
    if (!this.urlResolver) return null;
    return this.urlResolver.resolve(payload, scopeId);
  }

  async resolveUrlFallback(
    payload: SubmissionPayload & { kind: 'URL' },
    scopeId?: string,
  ): Promise<MetadataCandidate | null> {
    if (!this.urlResolver) return null;
    return this.urlResolver.resolve(payload, scopeId, { forceScrape: true });
  }

  async resolveFileCandidate(
    payload: SubmissionPayload & { kind: 'FILE' },
    scopeId?: string,
    context?: { userId?: string; projectId?: string; scopeId?: string },
  ): Promise<MetadataCandidate | null> {
    if (!this.fileResolver) return null;
    return this.fileResolver.resolve(payload, context ?? scopeId);
  }

  cleanPdfTitle(
    rawTitle?: unknown,
    filename?: string,
    authors?: unknown[],
    creators?: unknown[],
  ): string {
    return cleanPdfTitle(rawTitle, filename, authors, creators);
  }

  mapBibtexToRaw(
    item: ParsedBibtexEntry | Record<string, unknown>,
  ): Record<string, unknown> {
    return mapBibtexToRawRecord(item);
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
    return createCandidate({
      ...params,
      normalizer: this.normalizer,
    });
  }

  private buildEvidenceFields(
    rawMetadata: Record<string, unknown>,
    normalizedMetadata: Record<string, unknown>,
    sourceName: string,
  ): Record<string, FieldEvidence> {
    return buildEvidenceFields(rawMetadata, normalizedMetadata, sourceName);
  }
}
