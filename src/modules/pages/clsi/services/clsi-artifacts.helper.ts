/**
 * modules/pages/clsi/services/clsi-artifacts.helper.ts
 * Cached artifact synchronization, auxiliary file download, ZIP packaging, and build summary helpers.
 */

import { NotFoundException } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import * as fs from 'fs/promises';
import * as path from 'path';
import { CompilerDiagnostic } from '../domain/clsi.ports';
import {
  WorkspaceRepository,
  createZipStreamFromDisk,
  ZipDiskEntry,
} from '../repositories/workspace.repository';
import { CompileLogAnalyzer } from '@/modules/pages/diagnostics/domain';
import { CompilePipelineResult } from './compile-pipeline.service';

export interface EditorLastBuildSummary {
  status: 'ready' | 'error' | 'uncompiled';
  pdfArtifactUrl: string | null;
  synctexAvailable: boolean;
  lastCompiledAt: string | null;
  diagnostics: CompilerDiagnostic[];
}

export async function syncCachedArtifactsToScratchHelper(
  workspace: WorkspaceRepository,
  projectId: string,
  result: CompilePipelineResult,
): Promise<void> {
  try {
    const scratchDir = await workspace.ensureScratch(projectId);
    const writes: Promise<void>[] = [];
    if (result.pdf) {
      writes.push(
        fs.writeFile(
          path.join(scratchDir, 'output.pdf'),
          Buffer.from(result.pdf, 'base64'),
        ),
      );
    }
    if (result.synctex) {
      writes.push(
        fs.writeFile(
          path.join(scratchDir, 'output.synctex.gz'),
          Buffer.from(result.synctex, 'base64'),
        ),
      );
    }
    if (result.logs) {
      writes.push(
        fs.writeFile(path.join(scratchDir, 'output.log'), result.logs, 'utf8'),
      );
    }
    if (writes.length > 0) {
      await Promise.allSettled(writes);
    }
  } catch {
    // Non-blocking artifact sync to local workspace scratch
  }
}

export async function downloadAuxFileHelper(
  workspace: WorkspaceRepository,
  projectId: string,
  filename: string,
  res: FastifyReply,
  pageId?: string,
) {
  const scratchId = pageId || projectId;
  const buffer = await workspace.readAuxFile(scratchId, filename);
  if (!buffer) {
    throw new NotFoundException(`Artifact file ${filename} not found`);
  }

  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.log': 'text/plain; charset=utf-8',
    '.aux': 'text/plain; charset=utf-8',
    '.bbl': 'text/plain; charset=utf-8',
    '.blg': 'text/plain; charset=utf-8',
    '.toc': 'text/plain; charset=utf-8',
    '.lof': 'text/plain; charset=utf-8',
    '.lot': 'text/plain; charset=utf-8',
    '.fls': 'text/plain; charset=utf-8',
    '.fdb_latexmk': 'text/plain; charset=utf-8',
    '.synctex.gz': 'application/gzip',
    '.synctex': 'text/plain; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  res.header(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(filename)}"`,
  );
  res.header('Content-Type', contentType);
  return res.send(buffer);
}

export async function getLastBuildSummaryHelper(
  workspace: WorkspaceRepository,
  logParser: CompileLogAnalyzer,
  projectId: string,
  defaultMainFile = 'main.tex',
  pageId?: string,
): Promise<EditorLastBuildSummary> {
  const scratchId = pageId || projectId;
  const scratchDir = workspace.getScratchDir(scratchId);
  const statSafe = (filename: string) =>
    fs.lstat(path.join(scratchDir, filename)).catch(() => null);

  const [pdfStat, logStat, synctexGzStat, synctexStat] = await Promise.all([
    statSafe('output.pdf'),
    statSafe('output.log'),
    statSafe('output.synctex.gz'),
    statSafe('output.synctex'),
  ]);

  const isRegularNonEmptyFile = (
    stat: Awaited<ReturnType<typeof fs.lstat>> | null,
  ): boolean =>
    Boolean(stat && !stat.isSymbolicLink() && stat.isFile() && stat.size > 0);

  const hasPdf = isRegularNonEmptyFile(pdfStat);
  const hasLog = isRegularNonEmptyFile(logStat);

  if (!hasPdf && !hasLog) {
    return {
      status: 'uncompiled',
      pdfArtifactUrl: null,
      synctexAvailable: false,
      lastCompiledAt: null,
      diagnostics: [],
    };
  }

  const synctexAvailable =
    isRegularNonEmptyFile(synctexGzStat) || isRegularNonEmptyFile(synctexStat);
  const lastCompiledAt =
    (pdfStat?.mtime ?? logStat?.mtime)?.toISOString() ?? null;

  let diagnostics: CompilerDiagnostic[] = [];
  if (hasLog) {
    const logBuffer = await workspace
      .readAuxFile(scratchId, 'output.log')
      .catch(() => null);
    if (logBuffer && logBuffer.length > 0) {
      const maxBytes = 512 * 1024;
      const bounded =
        logBuffer.length > maxBytes
          ? logBuffer.subarray(logBuffer.length - maxBytes)
          : logBuffer;
      diagnostics = logParser
        .parse(bounded.toString('utf8'), defaultMainFile)
        .slice(0, 50);
    }
  }

  const pdfArtifactUrl = hasPdf
    ? pageId
      ? `/api/v1/pages/pages/${encodeURIComponent(pageId)}/artifacts/output.pdf`
      : `/api/v1/pages/spaces/${encodeURIComponent(projectId)}/artifacts/output.pdf`
    : null;

  return {
    status: hasPdf ? 'ready' : 'error',
    pdfArtifactUrl,
    synctexAvailable,
    lastCompiledAt,
    diagnostics,
  };
}

export async function downloadAllArtifactsZipHelper(
  workspace: WorkspaceRepository,
  projectId: string,
  res: FastifyReply,
  pageId?: string,
): Promise<void> {
  const scratchId = pageId || projectId;
  const scratchDir = workspace.getScratchDir(scratchId);
  const diskEntries: ZipDiskEntry[] = [];

  const walk = async (currentDir: string, relDir: string) => {
    try {
      const dirEntries = await fs.readdir(currentDir, {
        withFileTypes: true,
      });
      for (const entry of dirEntries) {
        if (
          entry.name === '.project-lock' ||
          entry.name === '.clsi-manifest.json' ||
          entry.name === '.clsi-build-state.json' ||
          entry.name === '.latexmkrc' ||
          entry.isSymbolicLink()
        ) {
          continue;
        }
        const fullPath = path.join(currentDir, entry.name);
        const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(fullPath, relPath);
        } else if (entry.isFile()) {
          const stat = await fs.lstat(fullPath);
          if (!stat.isSymbolicLink() && stat.isFile()) {
            diskEntries.push({ fullPath, relPath, date: stat.mtime });
          }
        }
      }
    } catch {
      // Ignored
    }
  };

  await walk(scratchDir, '');

  if (diskEntries.length === 0) {
    throw new NotFoundException(
      `No output artifacts found for project ${projectId}`,
    );
  }

  const zipStream = createZipStreamFromDisk(diskEntries);
  res.header(
    'Content-Disposition',
    `attachment; filename="project-${encodeURIComponent(projectId)}-artifacts.zip"`,
  );
  res.header('Content-Type', 'application/zip');
  return res.send(zipStream);
}
