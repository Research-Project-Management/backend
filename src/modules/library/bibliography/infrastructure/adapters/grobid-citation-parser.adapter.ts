import { Injectable, Optional } from '@nestjs/common';
import {
  ICitationParserPort,
  ParsedCitationReference,
} from '../../domain/ports/citation-parser.port';
import { GrobidClient } from '../../../shared-kernel/infra/grobid/grobid.client';

@Injectable()
export class GrobidCitationParserAdapter implements ICitationParserPort {
  constructor(@Optional() private readonly grobidClient?: GrobidClient) {}

  async processCitationList(
    rawCitations: string,
  ): Promise<ParsedCitationReference[]> {
    if (!this.grobidClient) {
      return [];
    }
    const refs = await this.grobidClient.processCitationList(rawCitations);
    return (refs || []).map((ref) => ({
      raw: ref.rawCitation || '',
      title: ref.title,
      authors: ref.authors?.map((name) => ({ name })),
      year: ref.year,
      doi: ref.doi,
      journal: ref.journal,
      volume: ref.volume,
      pages: ref.pages,
    }));
  }
}
