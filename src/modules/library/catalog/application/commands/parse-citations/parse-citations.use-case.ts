import { Injectable, Optional } from '@nestjs/common';
import {
  GrobidClient,
  GrobidReference,
} from '../../../../shared-kernel/infra/grobid/grobid.client';

export interface ParseCitationsCommand {
  rawCitations: string;
}

export interface ParseCitationsResult {
  references: GrobidReference[];
  count: number;
}

/**
 * Command Use Case — Parse Citations via GROBID
 *
 * Parses raw unformatted citation strings or multi-line bibliographies
 * via GROBID CRF (Conditional Random Fields) NLP model.
 * Returns structured GrobidReference objects.
 *
 * GrobidClient is injected as Optional — if GROBID is not configured,
 * the Use Case returns an empty list gracefully.
 *
 * Application layer: does NOT import Prisma, NestJS HTTP, or any other
 * infrastructure dependency beyond the GROBID client port.
 */
@Injectable()
export class ParseCitationsUseCase {
  constructor(@Optional() private readonly grobidClient?: GrobidClient) {}

  async execute(command: ParseCitationsCommand): Promise<ParseCitationsResult> {
    if (!this.grobidClient) {
      return { references: [], count: 0 };
    }

    const references = await this.grobidClient.processCitationList(
      command.rawCitations,
    );

    return {
      references,
      count: references.length,
    };
  }
}
