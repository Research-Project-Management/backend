/**
 * export-import/core/use-cases/import-project-zip.use-case.ts
 * Inbound Use Case extracting an uploaded ZIP archive and populating structure, docstore, and filestore.
 */

import { Injectable, Logger } from '@nestjs/common';
import { IZipEnginePort } from '../ports/zip-engine.port';
import { IManuscriptHydratorPort } from '../ports/manuscript-hydrator.port';
import { ImportSummaryVo } from '../domain/value-objects/import-summary.vo';
import { InvalidZipArchiveException } from '../domain/exceptions/invalid-zip-archive.exception';

export interface ImportProjectZipInput {
  projectId: string;
  zipBuffer: Buffer;
  userId?: string | null;
  preferredRootDoc?: string;
}

@Injectable()
export class ImportProjectZipUseCase {
  private readonly logger = new Logger(ImportProjectZipUseCase.name);

  constructor(
    private readonly zipEngine: IZipEnginePort,
    private readonly hydrator: IManuscriptHydratorPort,
  ) {}

  public async execute(input: ImportProjectZipInput): Promise<ImportSummaryVo> {
    const { projectId, zipBuffer, userId, preferredRootDoc } = input;

    const entries = this.zipEngine.extractZip(zipBuffer);

    if (entries.length === 0) {
      throw new InvalidZipArchiveException('Provided ZIP archive contains no usable file entries.');
    }

    return await this.hydrator.hydrateProjectEntries(projectId, entries, userId, preferredRootDoc);
  }
}
