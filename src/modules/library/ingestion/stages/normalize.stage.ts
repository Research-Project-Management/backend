import { Injectable, Logger } from '@nestjs/common';
import {
  MetadataCandidate,
  FieldEvidence,
} from '../types/metadata-candidate.types';
import { NormalizationPolicy } from '../policies/normalization.policy';

@Injectable()
export class NormalizeStage {
  private readonly logger = new Logger(NormalizeStage.name);

  constructor(private readonly normalizer: NormalizationPolicy) {}

  /**
   * Executes deterministic normalization over all current metadata candidates.
   */
  execute(candidates: MetadataCandidate[]): Promise<MetadataCandidate[]> {
    return Promise.resolve(
      candidates.map((candidate) => {
        const normalized = this.normalizer.normalize(
          candidate.normalizedMetadata,
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
