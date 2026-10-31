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
} from '@/modules/library/ingestion/types/submission.types';
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
import { XmlLegacyFormatsParser } from '@/modules/library/ingestion/parsers/xml-legacy-formats.parser';
import { BibliographyFormatRegistry } from '@/modules/library/ingestion/parsers/bibliography-format.registry';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import {
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  gunzipAsync,
} from '@/modules/library/core';
import {
  IWorkflowStage,
  IdentifyStageInput,
} from '@/modules/library/ingestion/types/workflow-stage.types';
import {
  createCandidate,
  buildEvidenceFields,
  mapBibtexToRawRecord,
  applyUserOverridesToCandidate,
} from './candidate-builder.helper';
import { IdentifyFileResolver, cleanPdfTitle } from './identify-file.resolver';
import { IdentifyUrlResolver } from './identify-url.resolver';

export {
  type ExtractedPdfMetadata,
  cleanPdfTitle,
} from './identify-file.resolver';
export {
  createCandidate,
  buildEvidenceFields,
  mapBibtexToRawRecord,
  applyUserOverridesToCandidate,
} from './candidate-builder.helper';

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

  /**
   * Executes identification and initial format translation into candidate envelopes.
   */
  async execute(input: IdentifyStageInput): Promise<MetadataCandidate[]> {
    const { runId: _runId, payload, scopeId, userId, projectId } = input;
    const context = {
      scopeId,
      userId,
      projectId:
        projectId ??
        (scopeId && scopeId !== 'user' && scopeId !== userId
          ? scopeId
          : undefined),
    };
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
        const recordContent = await this.resolveRecordContent(payload, context);
        const envelopes = await this.formatRegistry.parseEnvelopes(
          recordContent,
          payload.format,
        );
        for (const env of envelopes) {
          candidates.push(
            this.createCandidate({
              sourceKind: 'RECORD',
              sourceName: env.sourceName,
              sourceRecordId: env.sourceRecordId,
              rawMetadata: env.rawMetadata,
              confidenceScore: env.confidenceScore,
            }),
          );
        }
        break;
      }

      case 'URL': {
        const candidate = await this.resolveUrlCandidate(payload, scopeId);
        if (candidate) candidates.push(candidate);
        break;
      }

      case 'FILE': {
        const candidate = await this.resolveFileCandidate(
          payload,
          scopeId,
          context,
        );
        if (candidate) candidates.push(candidate);
        break;
      }

      case 'CONNECTOR': {
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
        normalizePmcid(rawValue) ||
        normalizePmid(rawValue) ||
        rawValue.replace(/^(?:pmcid|pmc|pmid):\s*/i, '').trim();
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

  private async resolveUrlCandidate(
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

  private async resolveFileCandidate(
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
