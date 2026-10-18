import {
  Injectable,
  Logger,
  Inject,
  Optional,
  BadRequestException,
} from '@nestjs/common';
import zlib from 'zlib';
import { promisify } from 'util';
import { SubmissionPayload } from '@/modules/library/ingestion/types/submission.types';
import {
  MetadataCandidate,
  FieldEvidence,
} from '@/modules/library/ingestion/types/metadata-candidate.types';
import { DoiParser } from '@/modules/library/ingestion/parsers/doi.parser';
import {
  BibtexParser,
  ParsedBibtexEntry,
} from '@/modules/library/ingestion/parsers/bibtex.parser';
import { RisParser } from '@/modules/library/ingestion/parsers/ris.parser';
import { CslParser } from '@/modules/library/ingestion/parsers/csl.parser';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import {
  EXTRACTION_FACADE,
  IExtractionFacade,
  normalizeArxivId,
  normalizePmid,
  normalizeIsbn,
} from '@/modules/library/core';
import { UrlMetadataScraperService } from '@/modules/library/ingestion/services/url-metadata-scraper.service';
import {
  IWorkflowStage,
  IdentifyStageInput,
} from '@/modules/library/ingestion/types/workflow-stage.types';
import {
  createCandidate,
  buildEvidenceFields,
  mapBibtexToRawRecord,
} from './candidate-builder.helper';
import { IdentifyFileResolver, cleanPdfTitle } from './identify-file.resolver';
import { IdentifyUrlResolver } from './identify-url.resolver';

const gunzipAsync = promisify(zlib.gunzip);

export {
  type ExtractedPdfMetadata,
  cleanPdfTitle,
} from './identify-file.resolver';
export {
  createCandidate,
  buildEvidenceFields,
  mapBibtexToRawRecord,
} from './candidate-builder.helper';

@Injectable()
export class IdentifyStage implements IWorkflowStage<
  IdentifyStageInput | string,
  MetadataCandidate[]
> {
  readonly stageName = 'IDENTIFY' as const;
  private readonly logger = new Logger(IdentifyStage.name);
  private readonly activeFileResolver: IdentifyFileResolver;
  private readonly activeUrlResolver: IdentifyUrlResolver;

  constructor(
    private readonly doiParser: DoiParser,
    private readonly bibtexParser: BibtexParser,
    private readonly risParser: RisParser,
    private readonly normalizer: NormalizationPolicy,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional()
    @Inject(EXTRACTION_FACADE)
    private readonly extractionGateway?: IExtractionFacade,
    @Optional() private readonly urlScraper?: UrlMetadataScraperService,
    @Optional() private readonly cslParser: CslParser = new CslParser(),
    @Optional() private readonly fileResolver?: IdentifyFileResolver,
    @Optional() private readonly urlResolver?: IdentifyUrlResolver,
  ) {
    this.activeFileResolver =
      fileResolver ??
      new IdentifyFileResolver(
        this.normalizer,
        this.storagePort,
        this.extractionGateway,
      );
    this.activeUrlResolver =
      urlResolver ?? new IdentifyUrlResolver(this.normalizer, this.urlScraper);
  }

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

  // Helper Resolvers

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
    return this.activeUrlResolver.resolve(payload, scopeId);
  }

  private async resolveFileCandidate(
    payload: SubmissionPayload & { kind: 'FILE' },
    scopeId?: string,
  ): Promise<MetadataCandidate> {
    return this.activeFileResolver.resolve(payload, scopeId);
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
