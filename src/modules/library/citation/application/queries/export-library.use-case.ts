import { Injectable, Logger } from '@nestjs/common';
import { ExportsService } from '../services/exports.service';
import { ExportLibraryDto } from '../dtos/exports.dto';
import { ExportResult } from '../../domain/types/exports.types';

export interface ExportLibraryQuery {
  userId: string;
  dto: ExportLibraryDto;
}

/**
 * Query Use Case — Export Library
 *
 * Clean Architecture & CQRS:
 * Orchestrates multi-format exports (BibTeX, RIS, CSL-JSON, CSV, Markdown).
 */
@Injectable()
export class ExportLibraryUseCase {
  private readonly logger = new Logger(ExportLibraryUseCase.name);

  constructor(private readonly exportsService: ExportsService) {}

  async execute(query: ExportLibraryQuery): Promise<ExportResult> {
    this.logger.debug(
      `Executing ExportLibraryUseCase for user ${query.userId} (format: ${query.dto.format})`,
    );
    return this.exportsService.exportLibrary(query.userId, query.dto);
  }
}
