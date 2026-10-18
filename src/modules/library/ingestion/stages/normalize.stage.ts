import { Injectable } from '@nestjs/common';
import {
  MetadataCandidate,
  FieldEvidence,
} from '@/modules/library/ingestion/types/metadata-candidate.types';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import { IWorkflowStage } from '@/modules/library/ingestion/types/workflow-stage.types';

@Injectable()
export class NormalizeStage implements IWorkflowStage<
  MetadataCandidate[],
  MetadataCandidate[]
> {
  readonly stageName = 'NORMALIZE' as const;
  constructor(private readonly normalizer: NormalizationPolicy) {}

  /**
   * Executes deterministic normalization over all current metadata candidates.
   */
  execute(candidates: MetadataCandidate[]): Promise<MetadataCandidate[]> {
    return Promise.resolve(
      candidates.map((candidate) => {
        // Fast-path passthrough: avoid redundant re-normalization if candidate was already normalized
        if (
          candidate.normalizedMetadata &&
          candidate.fields &&
          Object.keys(candidate.fields).length > 0
        ) {
          return candidate;
        }

        const normalized = this.normalizer.normalize(
          candidate.normalizedMetadata || {},
        );
        const fields: Record<string, FieldEvidence> = {};

        for (const [key, value] of Object.entries(normalized)) {
          if (value !== undefined && value !== null) {
            const existingField = candidate.fields[key];
            fields[key] = {
              path: key,
              value: existingField ? existingField.value : value,
              normalizedValue: value,
              confidence: existingField
                ? existingField.confidence
                : candidate.confidenceScore,
              sourceProvider: existingField
                ? existingField.sourceProvider
                : candidate.sourceName,
              retrievedAt: existingField
                ? existingField.retrievedAt
                : candidate.retrievedAt,
            };
          }
        }

        return {
          ...candidate,
          fields,
          normalizedMetadata: normalized,
        };
      }),
    );
  }
}
