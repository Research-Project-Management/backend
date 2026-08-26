import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { CslStyleRegistry } from './formatters/csl-style-registry';
import {
  CitationStyleId,
  CitationItemInput,
  FormattedCitationResult,
} from './types/citation.types';

@Injectable()
export class CitationService {
  private readonly logger = new Logger(CitationService.name);
  private readonly registry = new CslStyleRegistry();

  /**
   * Returns list of supported CSL styles.
   */
  getAvailableStyles() {
    return this.registry.listStyles();
  }

  /**
   * Formats a single citation item in the requested style.
   */
  formatItem(
    item: CitationItemInput,
    styleId: CitationStyleId = 'apa-7th',
    index: number = 1,
  ): FormattedCitationResult {
    const style = this.registry.getStyle(styleId);
    if (!style) {
      throw new BadRequestException(`Unsupported citation style: ${styleId}`);
    }
    return style.format(item, index);
  }

  /**
   * Formats a batch of citation items into ordered in-text citations and complete bibliography.
   */
  formatBatch(
    items: CitationItemInput[],
    styleId: CitationStyleId = 'apa-7th',
  ): {
    styleId: CitationStyleId;
    citations: Array<{ id?: string; inText: string; bibliography: string }>;
    bibliographyText: string;
  } {
    const style = this.registry.getStyle(styleId);
    if (!style) {
      throw new BadRequestException(`Unsupported citation style: ${styleId}`);
    }

    const citations = items.map((item, idx) => {
      const res = style.format(item, idx + 1);
      return {
        id: item.id,
        inText: res.inText,
        bibliography: res.bibliography,
      };
    });

    const bibliographyText = citations.map((c) => c.bibliography).join('\n\n');

    return {
      styleId,
      citations,
      bibliographyText,
    };
  }
}
