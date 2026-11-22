/**
 * modules/pages/clsi/services/clsi-artifacts.helper.ts
 * Cached artifact synchronization, auxiliary file download, ZIP packaging, and build summary helpers.
 */

import { Logger, NotFoundException } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import type { Queue } from 'bullmq';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { CompilePageDto } from '../dto/clsi.dto';
import type { RealtimeFacade } from '@/modules/realtime/realtime.facade';
import { CompilerDiagnostic } from '../domain/clsi.ports';
import { CompileSupersededError } from '../domain/fair-semaphore';
import { ClsiWorkerExecutionError } from '../domain/sandbox.errors';
import {
  WorkspaceRepository,
  createZipStreamFromDisk,
  ZipDiskEntry,
} from '../repositories/workspace.repository';
import { CompileLogAnalyzer } from '@/modules/pages/diagnostics/domain';
import { CompilePipelineResult } from './compile-pipeline.service';
import type { RemoteClsiClientAdapter } from './remote-clsi.client';

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
      const synctexBuf = Buffer.from(result.synctex, 'base64');
      const isGzip =
        synctexBuf.length >= 2 &&
        synctexBuf[0] === 0x1f &&
        synctexBuf[1] === 0x8b;
      writes.push(
        fs.writeFile(
          path.join(
            scratchDir,
            isGzip ? 'output.synctex.gz' : 'output.synctex',
          ),
          synctexBuf,
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
  remoteClient?: RemoteClsiClientAdapter,
) {
  const scratchId = pageId || projectId;
  let buffer = await workspace.readAuxFile(scratchId, filename);
  if (!buffer && remoteClient?.isEnabled()) {
    buffer = await remoteClient.tryRemoteDownloadArtifact(scratchId, filename);
  }
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

export async function getLastBuildSummaryHelper(
  workspace: WorkspaceRepository,
  logParser: CompileLogAnalyzer,
  projectId: string,
  defaultMainFile = 'main.tex',
  pageId?: string,
): Promise<EditorLastBuildSummary> {
  const scratchId = pageId || projectId;
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

export async function formatCompileResultForClient(params: {
  result: CompilePipelineResult;
  responseMode?: 'inline' | 'artifact';
  projectId: string;
  pageId?: string;
  scratchWorkspaceId: string;
  workspace: WorkspaceRepository;
}): Promise<CompilePipelineResult> {
  const {
    result,
    responseMode,
    projectId,
    pageId,
    scratchWorkspaceId,
    workspace,
  } = params;

  const isAdhoc =
    !projectId || projectId.startsWith('adhoc-') || projectId === 'default';
  const scratchDir = workspace.getScratchDir(scratchWorkspaceId);
  const isValidFile = isRegularNonEmptyFile;
  const { pdfStat, logStat, synctexGzStat, synctexStat } =
    await statScratchArtifacts(scratchDir);

  const basePrefix = !isAdhoc
    ? pageId
      ? `/api/v1/pages/pages/${encodeURIComponent(pageId)}/artifacts`
      : `/api/v1/pages/spaces/${encodeURIComponent(projectId)}/artifacts`
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

export function enrichUnreachableRemoteFailure(params: {
  pipelineResult: CompilePipelineResult;
  mainFile: string;
  remoteUrl: string | null;
}): CompilePipelineResult {
  const { pipelineResult, remoteUrl } = params;
  if (
    pipelineResult.success ||
    (pipelineResult.outcome !== 'clsi-unavailable' &&
      !pipelineResult.error.includes('No supported TeX engine'))
  ) {
    return pipelineResult;
  }
  const detailedError = `Remote CLSI service at ${remoteUrl} is unreachable (ensure the flux_clsi container is running) and no local TeX Live engine is installed.`;
  return {
    ...pipelineResult,
    outcome: 'clsi-unavailable',
    error: detailedError,
    logs: `${detailedError}\n\n${pipelineResult.logs || ''}`.trim(),
    diagnostics: [],
  };
}

export async function dispatchAndAwaitQueueCompileHelper(params: {
  compileQueue: Queue;
  activeQueueJobIds: Map<string, string>;
  dto: CompilePageDto;
  userId?: string;
  authorizedProjectId?: string;
  realtimeService?: RealtimeFacade;
  onSupersede?: (compileTargetId: string) => void;
  logger: Logger;
}): Promise<CompilePipelineResult> {
  const {
    compileQueue,
    activeQueueJobIds,
    dto,
    userId,
    authorizedProjectId,
    realtimeService,
    onSupersede,
    logger,
  } = params;

  const spaceId = authorizedProjectId || dto.spaceId || 'default';
  const compileTargetId = dto.pageId || spaceId;
  const effectiveTimeoutMs = dto.timeoutMs ?? 240000;

  if (realtimeService && spaceId && spaceId !== 'default') {
    try {
      await realtimeService.flushProjectBeforeCompile(spaceId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `Pre-queue Yjs flush encountered an error for project ${spaceId}: ${msg}`,
      );
    }
  }

  const existingJobId = activeQueueJobIds.get(compileTargetId);
  if (existingJobId) {
    onSupersede?.(compileTargetId);
    try {
      const oldJob = await compileQueue.getJob(existingJobId);
      if (oldJob) {
        await oldJob.remove().catch(() => {});
      }
    } catch {
      /* ignore stale job removal */
    }
  }

  const jobId = `clsi-${compileTargetId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const job = await compileQueue.add(
    'clsi-compile',
    { dto, userId, authorizedProjectId },
    {
      jobId,
      removeOnComplete: { age: 60, count: 10 },
      removeOnFail: { age: 300, count: 25 },
    },
  );
  activeQueueJobIds.set(compileTargetId, jobId);

  const startTime = Date.now();
  const pollIntervalMs = 200;
  try {
    while (Date.now() - startTime < effectiveTimeoutMs) {
      if (activeQueueJobIds.get(compileTargetId) !== jobId) {
        throw new CompileSupersededError('Compilation superseded or cancelled');
      }
      const state = await job.getState();
      if (state === 'completed') {
        const freshJob = await compileQueue.getJob(job.id!);
        return freshJob?.returnvalue as CompilePipelineResult;
      }
      if (state === 'failed') {
        const freshJob = await compileQueue.getJob(job.id!);
        const reason =
          freshJob?.failedReason || 'Job execution failed in CLSI worker';
        throw new ClsiWorkerExecutionError(reason, 503, 'CLSI_WORKER_FAILED');
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    throw new ClsiWorkerExecutionError(
      `CLSI compile job ${job.id} timed out after ${effectiveTimeoutMs}ms in queue`,
      504,
      'COMPILE_QUEUE_TIMEOUT',
    );
  } finally {
    if (activeQueueJobIds.get(compileTargetId) === jobId) {
      activeQueueJobIds.delete(compileTargetId);
    }
  }
}
