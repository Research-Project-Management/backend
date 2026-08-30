import { Injectable, Logger } from '@nestjs/common';
import { SubmissionPayload } from '../types/ingestion-submission.types';
import { MetadataCandidate } from '../types/metadata-candidate.types';
import { DoiParser } from '../parsers/doi.parser';
import { BibtexParser } from '../parsers/bibtex.parser';
import { RisParser } from '../parsers/ris.parser';
import { NormalizationPolicy } from '../policies/normalization.policy';
import { randomUUID } from 'crypto';

@Injectable()
export class IdentifyStage {
  private readonly logger = new Logger(IdentifyStage.name);

  constructor(
    private readonly doiParser: DoiParser,
    private readonly bibtexParser: BibtexParser,
    private readonly risParser: RisParser,
    private readonly normalizer: NormalizationPolicy,
  ) {}

  /**
   * Executes identification and initial format translation.
   */
  execute(
    runId: string,
    payload: SubmissionPayload,
  ): Promise<MetadataCandidate[]> {
    const candidates: MetadataCandidate[] = [];

    switch (payload.kind) {
      case 'IDENTIFIER': {
        if (payload.identifierType === 'DOI') {
          const cleanDoi = this.doiParser.normalize(payload.value);
          const normalized = this.normalizer.normalize({ doi: cleanDoi });
          candidates.push({
            candidateId: randomUUID(),
            sourceKind: 'IDENTIFIER',
            sourceName: 'DirectIdentifier',
            sourceRecordId: cleanDoi,
            retrievedAt: new Date().toISOString(),
            schemaVersion: '1.0.0',
            fields: {
              doi: {
                path: 'doi',
                value: payload.value,
                normalizedValue: cleanDoi,
                confidence: 1.0,
                sourceProvider: 'UserIdentifier',
                retrievedAt: new Date().toISOString(),
              },
            },
            normalizedMetadata: normalized,
            confidenceScore: 1.0,
          });
        } else if (payload.identifierType === 'ARXIV') {
          const cleanArxiv = payload.value.replace(/^arxiv:\s*/i, '').trim();
          const normalized = this.normalizer.normalize({ arxivId: cleanArxiv });
          candidates.push({
            candidateId: randomUUID(),
            sourceKind: 'IDENTIFIER',
            sourceName: 'DirectIdentifier',
            sourceRecordId: cleanArxiv,
            retrievedAt: new Date().toISOString(),
            schemaVersion: '1.0.0',
            fields: {
              arxivId: {
                path: 'arxivId',
                value: payload.value,
                normalizedValue: cleanArxiv,
                confidence: 1.0,
                sourceProvider: 'UserIdentifier',
                retrievedAt: new Date().toISOString(),
              },
            },
            normalizedMetadata: normalized,
            confidenceScore: 1.0,
          });
        } else if (payload.identifierType === 'PMID') {
          const cleanPmid = payload.value.replace(/^pmid:\s*/i, '').trim();
          const normalized = this.normalizer.normalize({ pmid: cleanPmid });
          candidates.push({
            candidateId: randomUUID(),
            sourceKind: 'IDENTIFIER',
            sourceName: 'DirectIdentifier',
            sourceRecordId: cleanPmid,
            retrievedAt: new Date().toISOString(),
            schemaVersion: '1.0.0',
            fields: {
              pmid: {
                path: 'pmid',
                value: payload.value,
                normalizedValue: cleanPmid,
                confidence: 1.0,
                sourceProvider: 'UserIdentifier',
                retrievedAt: new Date().toISOString(),
              },
            },
            normalizedMetadata: normalized,
            confidenceScore: 1.0,
          });
        }
        break;
      }

      case 'RECORD': {
        if (payload.format === 'BIBTEX') {
          const parsedList = this.bibtexParser.parse(payload.content);
          for (const item of parsedList) {
            const rawMetadata = {
              title: item.title,
              itemType: item.itemType,
              authors: item.authors,
              year: item.year,
              publicationTitle: item.journal || item.publisher,
              volume: item.volume,
              issue: item.issue,
              pages: item.pages,
              doi: item.doi,
              isbn: item.isbn,
              issn: item.issn,
              url: item.url,
              abstract: item.abstract,
              citationKey: item.citationKey,
            };
            const normalized = this.normalizer.normalize(rawMetadata);
            candidates.push({
              candidateId: randomUUID(),
              sourceKind: 'RECORD',
              sourceName: 'BibTeX',
              sourceRecordId: item.citationKey || item.doi,
              retrievedAt: new Date().toISOString(),
              schemaVersion: '1.0.0',
              fields: this.buildEvidenceFields(
                rawMetadata,
                normalized,
                'BibTeX',
              ),
              normalizedMetadata: normalized,
              confidenceScore: 0.95,
            });
          }
        } else if (payload.format === 'RIS') {
          const parsedList = this.risParser.parse(payload.content);
          for (const item of parsedList) {
            const normalized = this.normalizer.normalize(item);
            candidates.push({
              candidateId: randomUUID(),
              sourceKind: 'RECORD',
              sourceName: 'RIS',
              sourceRecordId: item.doi || item.citationKey,
              retrievedAt: new Date().toISOString(),
              schemaVersion: '1.0.0',
              fields: this.buildEvidenceFields(item, normalized, 'RIS'),
              normalizedMetadata: normalized,
              confidenceScore: 0.95,
            });
          }
        }
        break;
      }

      case 'URL': {
        const normalized = this.normalizer.normalize({ url: payload.url });
        candidates.push({
          candidateId: randomUUID(),
          sourceKind: 'URL',
          sourceName: 'UrlCapture',
          sourceRecordId: payload.url,
          retrievedAt: new Date().toISOString(),
          schemaVersion: '1.0.0',
          fields: {
            url: {
              path: 'url',
              value: payload.url,
              normalizedValue: normalized.url,
              confidence: 0.8,
              sourceProvider: 'UrlCapture',
              retrievedAt: new Date().toISOString(),
            },
          },
          normalizedMetadata: normalized,
          confidenceScore: 0.8,
        });
        break;
      }

      case 'FILE': {
        candidates.push({
          candidateId: randomUUID(),
          sourceKind: 'FILE',
          sourceName: 'StagedPdf',
          sourceRecordId: payload.fileId,
          retrievedAt: new Date().toISOString(),
          schemaVersion: '1.0.0',
          fields: {},
          normalizedMetadata: {
            title: payload.filename || 'Uploaded Document',
          },
          confidenceScore: 0.7,
        });
        break;
      }
    }

    return Promise.resolve(candidates);
  }

  private buildEvidenceFields(
    raw: Record<string, any>,
    normalized: Record<string, any>,
    sourceName: string,
  ): Record<string, any> {
    const fields: Record<string, any> = {};
    for (const key of Object.keys(normalized)) {
      if (normalized[key] !== undefined && normalized[key] !== null) {
        fields[key] = {
          path: key,
          value: raw[key],
          normalizedValue: normalized[key],
          confidence: 0.95,
          sourceProvider: sourceName,
          retrievedAt: new Date().toISOString(),
        };
      }
    }
    return fields;
  }
}
