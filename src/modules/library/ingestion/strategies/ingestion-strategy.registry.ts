import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { IIngestionStrategy } from './ingestion-strategy.interface';
import { DoiIngestionStrategy } from './doi-ingestion.strategy';
import { UrlIngestionStrategy } from './url-ingestion.strategy';
import { PdfIngestionStrategy } from './pdf-ingestion.strategy';
import { BibtexIngestionStrategy } from './bibtex-ingestion.strategy';

@Injectable()
export class IngestionStrategyRegistry {
  private readonly logger = new Logger(IngestionStrategyRegistry.name);
  private readonly strategies = new Map<string, IIngestionStrategy>();

  constructor(
    doiStrategy?: DoiIngestionStrategy,
    urlStrategy?: UrlIngestionStrategy,
    pdfStrategy?: PdfIngestionStrategy,
    bibtexStrategy?: BibtexIngestionStrategy,
  ) {
    if (doiStrategy) this.register(doiStrategy);
    if (urlStrategy) this.register(urlStrategy);
    if (pdfStrategy) this.register(pdfStrategy);
    if (bibtexStrategy) this.register(bibtexStrategy);
  }

  register(strategy: IIngestionStrategy): void {
    this.strategies.set(strategy.source, strategy);
    this.logger.debug(
      `Registered IngestionStrategy for source: ${strategy.source}`,
    );
  }

  getStrategy(source: string): IIngestionStrategy {
    const strategy = this.strategies.get(source);
    if (!strategy) {
      throw new BadRequestException(`Unsupported ingestion source: ${source}`);
    }
    return strategy;
  }

  hasStrategy(source: string): boolean {
    return this.strategies.has(source);
  }
}
