/**
 * modules/pages/export-import/adapters/pandoc.adapter.ts
 * Document format conversion powered by Pandoc CLI (LaTeX <-> DOCX / Markdown / HTML)
 * with isolated temp dirs, safe `execFile` (no shell), strict timeout, and graceful fallback.
 */

import { Injectable, Optional } from '@nestjs/common';
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type { ExportFormattedDocResult } from '../domain/latex-export.domain';

const execFileAsync = promisify(execFile);

export type PandocExportFormat = 'docx' | 'md' | 'html';
export type PandocImportFormat = 'docx' | 'md';

const EXPORT_META: Record<
  PandocExportFormat,
  { ext: string; pandocTo: string; mimeType: string; isBinary: boolean; extraArgs: string[] }
> = {
  docx: {
    ext: '.docx',
    pandocTo: 'docx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    isBinary: true,
    extraArgs: [],
  },
  md: {
    ext: '.md',
    pandocTo: 'gfm',
    mimeType: 'text/markdown; charset=utf-8',
    isBinary: false,
    extraArgs: ['--wrap=none'],
  },
  html: {
    ext: '.html',
    pandocTo: 'html5',
    mimeType: 'text/html; charset=utf-8',
    isBinary: false,
    extraArgs: ['--standalone', '--mathml'],
  },
};

export function normalizePandocExportFormat(
  rawFormat: string,
): PandocExportFormat | null {
  const f = (rawFormat || '').toLowerCase().trim();
  if (f === 'docx' || f === 'word') return 'docx';
  if (f === 'md' || f === 'markdown') return 'md';
  if (f === 'html' || f === 'htm') return 'html';
  return null;
}

@Injectable()
export class PandocAdapter {
  private readonly bin: string;

  constructor(@Optional() bin?: string) {
    this.bin = bin || process.env.PANDOC_BIN || 'pandoc';
  }

  /**
   * Converts LaTeX source into DOCX (with native OMML equations), GFM Markdown, or standalone HTML5.
   * Returns `null` when Pandoc is unavailable or fails so callers can fall back to the JS transpiler.
   */
  public async exportLatex(params: {
    rawFilename: string;
    content: string;
    format: string;
    timeoutMs?: number;
  }): Promise<ExportFormattedDocResult | null> {
    const targetFormat = normalizePandocExportFormat(params.format);
    if (!targetFormat) return null;

    const meta = EXPORT_META[targetFormat];
    const baseName =
      path.basename(params.rawFilename || 'document.tex', path.extname(params.rawFilename || 'document.tex')) ||
      'document';
    const outFilename = `${baseName}${meta.ext}`;

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-pandoc-exp-'));
    try {
      const inPath = path.join(tmpDir, 'input.tex');
      const outPath = path.join(tmpDir, `output${meta.ext}`);
      await fs.writeFile(inPath, params.content || '', 'utf8');

      await execFileAsync(
        this.bin,
        [
          '-f',
          'latex',
          '-t',
          meta.pandocTo,
          ...meta.extraArgs,
          '-o',
          outPath,
          inPath,
        ],
        {
          cwd: tmpDir,
          timeout: params.timeoutMs ?? 30_000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      const outBuf = await fs.readFile(outPath);
      if (outBuf.byteLength === 0) return null;

      return {
        filename: outFilename,
        mimeType: meta.mimeType,
        content: meta.isBinary
          ? outBuf.toString('base64')
          : outBuf.toString('utf8'),
        isBase64: meta.isBinary,
        sizeBytes: outBuf.byteLength,
      };
    } catch {
      return null;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Converts an uploaded DOCX or Markdown buffer into standalone LaTeX source via Pandoc.
   * Returns `null` when Pandoc is unavailable so callers can fall back to `LatexImportTranspiler`.
   */
  public async importToLatex(params: {
    buffer: Buffer;
    format: PandocImportFormat;
    timeoutMs?: number;
  }): Promise<string | null> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-pandoc-imp-'));
    try {
      const ext = params.format === 'docx' ? '.docx' : '.md';
      const fromFormat = params.format === 'docx' ? 'docx' : 'markdown';
      const inPath = path.join(tmpDir, `input${ext}`);
      const outPath = path.join(tmpDir, 'main.tex');
      await fs.writeFile(inPath, params.buffer);

      await execFileAsync(
        this.bin,
        ['-f', fromFormat, '-t', 'latex', '--standalone', '-o', outPath, inPath],
        {
          cwd: tmpDir,
          timeout: params.timeoutMs ?? 30_000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      const latex = await fs.readFile(outPath, 'utf8');
      return latex.trim().length > 0 ? latex : null;
    } catch {
      return null;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
