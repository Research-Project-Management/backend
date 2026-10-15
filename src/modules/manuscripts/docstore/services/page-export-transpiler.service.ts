/**
 * modules/manuscripts/docstore/services/page-export-transpiler.service.ts
 * Injectable wrapper delegating to pure in-process functions in domain/latex-export-transpiler.ts.
 */

import { Injectable } from '@nestjs/common';
import type { PkZipEntry } from '@/modules/manuscripts/shared/zip/pkzip-builder.util';
import {
  IncludedProjectDoc,
  escapeXml,
  convertLatexToMarkdown,
  convertLatexToHtml,
  buildMinimalZip,
  convertLatexToDocxBuffer,
  resolveIncludedLatexContent,
} from '../domain/latex-export-transpiler';

export type { IncludedProjectDoc };
export {
  escapeXml,
  convertLatexToMarkdown,
  convertLatexToHtml,
  buildMinimalZip,
  convertLatexToDocxBuffer,
  resolveIncludedLatexContent,
};

@Injectable()
export class PageExportTranspilerService {
  public escapeXml(text: string): string {
    return escapeXml(text);
  }

  public convertLatexToMarkdown(latex: string, fallbackTitle?: string): string {
    return convertLatexToMarkdown(latex, fallbackTitle);
  }

  public convertLatexToHtml(latex: string, title?: string): string {
    return convertLatexToHtml(latex, title);
  }

  public buildMinimalZip(entries: PkZipEntry[]): Buffer {
    return buildMinimalZip(entries);
  }

  public convertLatexToDocxBuffer(latex: string, title?: string): Buffer {
    return convertLatexToDocxBuffer(latex, title);
  }

  public resolveIncludedLatexContent(
    rootContent: string,
    projectDocs: Array<{ id: string; path: string; lines: unknown }>,
    visited = new Set<string>(),
    depth = 0,
  ): string {
    return resolveIncludedLatexContent(
      rootContent,
      projectDocs,
      visited,
      depth,
    );
  }
}
