import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import {
  MetadataCandidate,
  FieldEvidence,
} from '../types/metadata-candidate.types';
import { METADATA_PORT, MetadataPort } from '../metadata/types/metadata.types';
import { NormalizationPolicy } from '../policies/normalization.policy';
import { randomUUID } from 'crypto';

@Injectable()
export class EnrichStage {
  private readonly logger = new Logger(EnrichStage.name);

  constructor(
    @Optional()
    @Inject(METADATA_PORT)
    private readonly metadataService?: MetadataPort,
    private readonly normalizer?: NormalizationPolicy,
  ) {}

  /**
   * Executes external enrichment for candidates with recognized identifiers.
   * A PDF whose first page yields a credible title but no identifier is also
   * eligible for a title lookup. MetadataService validates title similarity
   * before accepting such a result, so a filename fallback cannot be promoted
   * into unrelated bibliographic data.
   */
  async execute(
    workspaceId: string,
    candidates: MetadataCandidate[],
  ): Promise<MetadataCandidate[]> {
    if (!this.metadataService) {
      this.logger.debug(
        'MetadataService not available, skipping enrichment stage',
      );
      return candidates;
    }

    const enrichedCandidates = [...candidates];

    for (const candidate of candidates) {
      const doi = candidate.normalizedMetadata.doi;
      const arxivId = candidate.normalizedMetadata.arxivId;
      const pmid = candidate.normalizedMetadata.pmid;
      const title = candidate.normalizedMetadata.title?.trim();
      const isCredibleTitle =
        Boolean(title) &&
        title!.length >= 12 &&
        !/\.pdf$/i.test(title!) &&
        !/^(uploaded document|untitled|document)$/i.test(title!);
      const query = doi || arxivId || pmid || (isCredibleTitle ? title : undefined);

      if (!query) continue;

      try {
        const resolved = await this.metadataService.resolve({
          query,
          workspaceId,
        });

        if (resolved && resolved.metadata) {
          const rawMetadata = resolved.metadata;
          const normalized = this.normalizer
            ? this.normalizer.normalize(rawMetadata)
            : rawMetadata;

          const fields: Record<string, FieldEvidence> = {};

          for (const [fieldName, propertyValue] of Object.entries(normalized)) {
            if (propertyValue !== undefined && propertyValue !== null) {
              const provenance = resolved.provenance[fieldName];
              fields[fieldName] = {
                path: fieldName,
                value: rawMetadata[fieldName as keyof typeof rawMetadata],
                normalizedValue: propertyValue,
                confidence: provenance ? provenance.confidence : 0.9,
                sourceProvider: provenance ? provenance.provider : 'MetadataResolution',
                retrievedAt: provenance ? provenance.fetchedAt : resolved.resolvedAt,
              };
            }
          }

          enrichedCandidates.push({
            candidateId: randomUUID(),
            sourceKind: 'PROVIDER',
            sourceName: 'EnrichedProvider',
            sourceRecordId: resolved.canonicalId,
            retrievedAt: resolved.resolvedAt,
            schemaVersion: '1.0.0',
            fields,
            normalizedMetadata: normalized,
            confidenceScore: 0.95,
          });
        }
      } catch (caughtError: unknown) {
        const errorMessage =
          caughtError instanceof Error
            ? caughtError.message
            : String(caughtError);
        this.logger.warn(
          `Enrichment lookup failed for query "${query}": ${errorMessage}`,
        );
        // Non-blocking: enrichment failure must degrade gracefully without aborting run
      }
    }

    return enrichedCandidates;
  }
}
