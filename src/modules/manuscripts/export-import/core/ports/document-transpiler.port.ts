/**
 * export-import/core/ports/document-transpiler.port.ts
 * Outbound Port for transpiling Word (.docx) and Markdown (.md) documents into LaTeX projects.
 */

import { ArchiveEntryVo } from '../domain/value-objects/archive-entry.vo';

export interface TranspiledProjectResult {
  mainTex: string;
  entries: ArchiveEntryVo[];
  detectedTitle?: string;
  warnings: string[];
}

export abstract class IDocumentTranspilerPort {
  abstract transpileMarkdown(
    content: string,
    fileName?: string,
  ): Promise<TranspiledProjectResult>;

  abstract transpileDocx(
    docxBuffer: Buffer,
    fileName?: string,
  ): Promise<TranspiledProjectResult>;
}
