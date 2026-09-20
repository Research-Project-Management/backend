import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  IngestionPort,
  INGESTION_PORT,
} from '../../domain/types/ingestion.types';

export interface UnifiedIngestCommand {
  command: any;
}

@Injectable()
export class UnifiedIngestUseCase {
  private readonly logger = new Logger(UnifiedIngestUseCase.name);

  constructor(
    @Inject(INGESTION_PORT)
    private readonly unifiedService: IngestionPort,
  ) {}

  async execute(command: any) {
    this.logger.debug(
      `Executing unified ingestion (source: ${command?.source})`,
    );
    return this.unifiedService.ingest(command);
  }
}
