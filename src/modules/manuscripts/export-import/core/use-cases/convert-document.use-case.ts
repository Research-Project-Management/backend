/**
 * export-import/core/use-cases/convert-document.use-case.ts
 * Inbound Use Case converting uploaded Word (.docx) or Markdown (.md) documents
 * into an editable multi-file LaTeX project in the active workspace.
 */

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as path from 'node:path';
import { IDocumentTranspilerPort } from '../ports/document-transpiler.port';
import { IManuscriptHydratorPort } from '../ports/manuscript-hydrator.port';
import { ImportSummaryVo } from '../domain/value-objects/import-summary.vo';

export interface ConvertDocumentInput {
  projectId: string;
  fileBuffer: Buffer;
  fileName: string;
  format?: 'docx' | 'md';
  userId?: string | null;
}

@Injectable()
export class ConvertDocumentUseCase {
  private readonly logger = new Logger(ConvertDocumentUseCase.name);

  constructor(
    private readonly transpiler: IDocumentTranspilerPort,
    private readonly hydrator: IManuscriptHydratorPort,
  ) {}

  public async execute(input: ConvertDocumentInput): Promise<ImportSummaryVo> {
    const { projectId, fileBuffer, fileName, userId } = input;

    if (!fileBuffer || fileBuffer.length === 0) {
      throw new BadRequestException('Uploaded document payload is empty.');
    }

    // Determine format
    const ext = path.extname(fileName).toLowerCase();
    const effectiveFormat =
      input.format || (ext === '.docx' ? 'docx' : ext === '.md' ? 'md' : null);

    if (!effectiveFormat) {
      throw new BadRequestException(
        `Unsupported document format for conversion: "${ext}". Supported formats: .docx, .md`,
      );
    }

    this.logger.log(
      `Converting ${effectiveFormat.toUpperCase()} document "${fileName}" (${fileBuffer.length} bytes) for project ${projectId}`,
    );

    let transpileResult;
    if (effectiveFormat === 'docx') {
      transpileResult = await this.transpiler.transpileDocx(
        fileBuffer,
        fileName,
      );
    } else {
      const text = fileBuffer.toString('utf8');
      transpileResult = await this.transpiler.transpileMarkdown(text, fileName);
    }

    // Hydrate generated LaTeX and companion media entries into project node tree
    const summary = await this.hydrator.hydrateProjectEntries(
      projectId,
      transpileResult.entries,
      userId,
      'main.tex',
    );

    return summary;
  }
}
