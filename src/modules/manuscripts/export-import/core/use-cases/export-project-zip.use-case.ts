/**
 * export-import/core/use-cases/export-project-zip.use-case.ts
 * Inbound Use Case packaging a project's virtual file tree, docs, and assets into a PKZIP archive.
 */

import { Injectable, Logger } from '@nestjs/common';
import { IManuscriptAggregatorPort } from '../ports/manuscript-aggregator.port';
import { IZipEnginePort } from '../ports/zip-engine.port';
import { ArchiveManifest } from '../domain/entities/archive-manifest.entity';

export interface ExportProjectZipInput {
  projectId: string;
  projectName?: string;
  includePdf?: boolean;
}

export interface ExportProjectZipOutput {
  zipBuffer: Buffer;
  manifest: ArchiveManifest;
}

@Injectable()
export class ExportProjectZipUseCase {
  private readonly logger = new Logger(ExportProjectZipUseCase.name);

  constructor(
    private readonly aggregator: IManuscriptAggregatorPort,
    private readonly zipEngine: IZipEnginePort,
  ) {}

  public async execute(input: ExportProjectZipInput): Promise<ExportProjectZipOutput> {
    const { projectId, projectName, includePdf = false } = input;

    const files = await this.aggregator.collectProjectEntries(projectId, includePdf);

    // If project is brand new and has no entries yet, supply a default main.tex
    if (files.length === 0) {
      files.push({
        path: 'main.tex',
        data: Buffer.from('\\documentclass{article}\n\\begin{document}\nHello World\n\\end{document}', 'utf8'),
      });
    }

    const zipBuffer = this.zipEngine.buildZip(files);

    const hasPdf = files.some((f) => f.path.toLowerCase().endsWith('.pdf'));

    const manifest = new ArchiveManifest({
      projectId,
      projectName,
      fileCount: files.length,
      totalSizeBytes: zipBuffer.length,
      hasCompiledPdf: hasPdf,
    });

    return {
      zipBuffer,
      manifest,
    };
  }
}
