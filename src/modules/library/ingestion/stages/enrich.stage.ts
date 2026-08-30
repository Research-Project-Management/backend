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
   * Executes external enrichment for candidates with valid identifiers (DOI, arXiv, PMID, etc.).
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
      const query = doi || arxivId || pmid;

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

          for (const [key, val] of Object.entries(normalized)) {
            if (val !== undefined && val !== null) {
              const prov = resolved.provenance[key];
              fields[key] = {
                path: key,
                value: rawMetadata[key as keyof typeof rawMetadata],
                normalizedValue: val,
                confidence: prov ? prov.confidence : 0.9,
                sourceProvider: prov ? prov.provider : 'MetadataResolution',
                retrievedAt: prov ? prov.fetchedAt : resolved.resolvedAt,
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
      } catch (err: any) {
        this.logger.warn(
          `Enrichment lookup failed for query "${query}": ${err?.message || err}`,
        );
        // Non-blocking: enrichment failure must degrade gracefully without aborting run
      }
    }

    return enrichedCandidates;
  }
}
