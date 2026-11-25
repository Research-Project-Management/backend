/**
 * modules/pages/clsi/services/output.service.ts
 * Output artifacts, bounded log reading, auxiliary downloads, ZIP packaging, and build summary.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { forwardRef, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { CompilerDiagnostic } from '../domain/ports';
import { ClsiRepository } from '../clsi.repository';
import { Readable } from 'node:stream';
import { createZipStream, ZipEntry } from '../../core/utils/zip-builder';
import { CompileLogParser } from '../domain/log-parser/tex-log.parser';
import { CompilePipelineResult } from './compile.service';
import { ClsiRuntimeAdapter } from '../adapters/clsi-runtime.adapter';
export {
  MAX_PARSE_LOG_BYTES,
  MAX_BIB_LOG_BYTES,
  MAX_INLINE_LOG_BYTES,
  readBoundedLogFile,
  boundInlineLogText,
} from '../utils/bounded-log.util';
import {
  MAX_PARSE_LOG_BYTES,
  MAX_INLINE_LOG_BYTES,
  readBoundedLogFile,
  boundInlineLogText,
} from '../utils/bounded-log.util';


export interface EditorLastBuildSummary {
  status: 'ready' | 'error' | 'uncompiled';
  pdfArtifactUrl: string | null;
  synctexAvailable: boolean;
  lastCompiledAt: string | null;
  diagnostics: CompilerDiagnostic[];
}

export async function downloadAuxFile(
  workspace: ClsiRepository,
  spaceId: string,
  filename: string,
  res: FastifyReply,
  pageId?: string,
  runtime?: ClsiRuntimeAdapter,
) {
  const scratchId = pageId || spaceId;
  const buffer = runtime
    ? await runtime.readAuxFile(scratchId, filename, true)
    : await workspace.readAuxFile(scratchId, filename);
  if (!buffer) {
    throw new NotFoundException(`Artifact file ${filename} not found`);
  }

  const lower = filename.toLowerCase();
  const ext = path.extname(lower);
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
  const contentType = lower.endsWith('.synctex.gz')
    ? 'application/gzip'
    : mimeTypes[ext] || 'application/octet-stream';

  res.header(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(filename)}"`,
  );
  res.header('Content-Type', contentType);
  return res.send(buffer);
}

async function statScratchArtifacts(scratchDir: string) {
  const statSafe = (filename: string) =>
    fs.lstat(path.join(scratchDir, filename)).catch(() => null);
  const [pdfStat, logStat, synctexGzStat, synctexStat] = await Promise.all([
    statSafe('output.pdf'),
    statSafe('output.log'),
    statSafe('output.synctex.gz'),
    statSafe('output.synctex'),
  ]);
  return { pdfStat, logStat, synctexGzStat, synctexStat };
}

function isRegularNonEmptyFile(
  stat: Awaited<ReturnType<typeof fs.lstat>> | null,
): boolean {
  return Boolean(
    stat && !stat.isSymbolicLink() && stat.isFile() && stat.size > 0,
  );
}

export async function getLastBuildSummary(
  workspace: ClsiRepository,
  logParser: CompileLogParser,
  spaceId: string,
  defaultMainFile = 'main.tex',
  pageId?: string,
): Promise<EditorLastBuildSummary> {
  const scratchId = pageId || spaceId;
  const scratchDir = workspace.getScratchDir(scratchId);
  const { pdfStat, logStat, synctexGzStat, synctexStat } =
    await statScratchArtifacts(scratchDir);

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
    ? `/api/v1/pages/clsi/pages/${encodeURIComponent(scratchId)}/artifacts/output.pdf`
    : null;

  return {
    status: hasPdf ? 'ready' : 'error',
    pdfArtifactUrl,
    synctexAvailable,
    lastCompiledAt,
    diagnostics,
  };
}

export async function downloadAllArtifactsZip(
  workspace: ClsiRepository,
  spaceId: string,
  res: FastifyReply,
  pageId?: string,
): Promise<void> {
  const scratchId = pageId || spaceId;
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
      `No output artifacts found for project ${spaceId}`,
    );
  }

  const zipStream = createZipStreamFromDisk(diskEntries);
  res.header(
    'Content-Disposition',
    `attachment; filename="project-${encodeURIComponent(spaceId)}-artifacts.zip"`,
  );
  res.header('Content-Type', 'application/zip');
  return res.send(zipStream);
}

export async function formatCompileResultForClient(params: {
  result: CompilePipelineResult;
  responseMode?: 'inline' | 'artifact';
  spaceId: string;
  pageId?: string;
  scratchWorkspaceId: string;
  workspace: ClsiRepository;
}): Promise<CompilePipelineResult> {
  const {
    result,
    responseMode,
    spaceId,
    pageId,
    scratchWorkspaceId,
    workspace,
  } = params;

  const isAdhoc =
    !spaceId || spaceId.startsWith('adhoc-') || spaceId === 'default';
  const scratchDir = workspace.getScratchDir(scratchWorkspaceId);
  const isValidFile = isRegularNonEmptyFile;
  const { pdfStat, logStat, synctexGzStat, synctexStat } =
    await statScratchArtifacts(scratchDir);

  const basePrefix = !isAdhoc
    ? `/api/v1/pages/clsi/pages/${encodeURIComponent(pageId || scratchWorkspaceId)}/artifacts`
    : undefined;
  const version = Date.now();
  const hasLogOnDisk = isValidFile(logStat);
  const logArtifactUrl =
    basePrefix &&
    (hasLogOnDisk || Boolean(result.logs && result.logs.length > 0)) &&
    result.outcome !== 'validation-problems' &&
    result.outcome !== 'clsi-unavailable' &&
    result.outcome !== 'terminated'
      ? `${basePrefix}/output.log?v=${version}`
      : undefined;

  const logMeta =
    result.logMeta || logArtifactUrl
      ? {
          sizeBytes:
            result.logMeta?.sizeBytes ??
            (hasLogOnDisk
              ? logStat!.size
              : Buffer.byteLength(result.logs || '', 'utf8')),
          truncated: Boolean(result.logMeta?.truncated),
          ...(logArtifactUrl ? { logArtifactUrl } : {}),
          ...(result.logMeta?.bibLogFiles
            ? { bibLogFiles: result.logMeta.bibLogFiles }
            : {}),
        }
      : undefined;

  if (!result.success) {
    return logMeta ? { ...result, logMeta } : result;
  }

  const hasPdfOnDisk = isValidFile(pdfStat);
  const hasSynctexGz = isValidFile(synctexGzStat);
  const hasSynctexPlain = isValidFile(synctexStat);
  const synctexAvailable = Boolean(
    result.synctex || hasSynctexGz || hasSynctexPlain,
  );
  const pdfSizeBytes = result.pdf
    ? Buffer.byteLength(result.pdf, 'base64')
    : (result.pdfSizeBytes ?? (hasPdfOnDisk ? pdfStat!.size : 0));

  if (isAdhoc || !basePrefix) {
    return {
      ...result,
      ...(logMeta ? { logMeta } : {}),
      synctexAvailable,
      pdfSizeBytes,
    };
  }

  const pdfArtifactUrl = hasPdfOnDisk
    ? `${basePrefix}/output.pdf?v=${version}`
    : undefined;
  const synctexFilename = hasSynctexGz
    ? 'output.synctex.gz'
    : hasSynctexPlain
      ? 'output.synctex'
      : null;
  const synctexArtifactUrl =
    synctexAvailable && synctexFilename
      ? `${basePrefix}/${synctexFilename}?v=${version}`
      : undefined;

  const enriched: CompilePipelineResult = {
    ...result,
    ...(logMeta ? { logMeta } : {}),
    ...(pdfArtifactUrl ? { pdfArtifactUrl } : {}),
    synctexAvailable,
    ...(synctexArtifactUrl ? { synctexArtifactUrl } : {}),
    pdfSizeBytes,
  };

  if (responseMode === 'artifact' && pdfArtifactUrl && hasPdfOnDisk) {
    return {
      ...enriched,
      pdf: '',
      synctex: undefined,
    };
  }

  return enriched;
}

export interface ZipDiskEntry {
  fullPath: string;
  relPath: string;
  date?: Date;
}

export function createZipStreamFromDisk(files: ZipDiskEntry[]): Readable {
  const pkEntries: ZipEntry[] = files.map((entry) => ({
    path: entry.relPath,
    date: entry.date,
    getData: async () => {
      try {
        const stat = await fs.lstat(entry.fullPath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          return null;
        }
        return await fs.readFile(entry.fullPath);
      } catch {
        return null;
      }
    },
  }));

  return createZipStream(pkEntries);
}

@Injectable()
export class OutputService {
  private readonly logParser = new CompileLogParser();

  constructor(
    private readonly workspace: ClsiRepository,
    @Inject(forwardRef(() => ClsiRuntimeAdapter))
    private readonly runtime: ClsiRuntimeAdapter,
  ) {}

  public async syncCachedArtifactsToScratch(
    spaceId: string,
    result: CompilePipelineResult,
  ): Promise<void> {
    return this.workspace.writeCachedArtifacts(spaceId, result);
  }

  public async downloadAuxFile(
    spaceId: string,
    filename: string,
    res: FastifyReply,
    pageId?: string,
  ): Promise<FastifyReply> {
    return downloadAuxFile(
      this.workspace,
      spaceId,
      filename,
      res,
      pageId,
      this.runtime,
    );
  }

  public async getLastBuildSummary(
    spaceId: string,
    defaultMainFile = 'main.tex',
    pageId?: string,
  ): Promise<EditorLastBuildSummary> {
    return getLastBuildSummary(
      this.workspace,
      this.logParser,
      spaceId,
      defaultMainFile,
      pageId,
    );
  }

  public async downloadAllArtifactsZip(
    spaceId: string,
    res: FastifyReply,
    pageId?: string,
  ): Promise<void> {
    return downloadAllArtifactsZip(this.workspace, spaceId, res, pageId);
  }

  public async formatCompileResultForClient(params: {
    result: CompilePipelineResult;
    responseMode?: 'inline' | 'artifact';
    spaceId: string;
    pageId?: string;
    scratchWorkspaceId: string;
  }): Promise<CompilePipelineResult> {
    return formatCompileResultForClient({
      ...params,
      workspace: this.workspace,
    });
  }
}
