/**
 * modules/pages/clsi/adapters/scratch-disk.adapter.ts
 * File-system adapters for CLSI scratch directories:
 * - ScratchLockAdapter (.project-lock concurrency guard)
 * - DiskUsageCleaner (stale scratch TTL & disk quota GC)
 * - OutputFileFinder (generated LaTeX output discovery)
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PagesDomainError } from '@/modules/pages/core/domain/errors';
import { DiscoveredOutputFile } from '../domain/ports';

export interface LockOptions {
  intervalMs?: number;
  maxWaitMs?: number;
  staleMs?: number;
  signal?: AbortSignal;
}

export class ScratchLockAdapter {
  private static readonly LOCK_FILENAME = '.project-lock';
  private static readonly DEFAULT_INTERVAL_MS = 50;
  private static readonly DEFAULT_MAX_WAIT_MS = 30000;
  private static readonly DEFAULT_STALE_MS = 5 * 60 * 1000;

  public async runWithLock<T>(
    spaceId: string,
    scratchDir: string,
    action: () => Promise<T>,
    options?: LockOptions,
  ): Promise<T> {
    const unlock = await this.acquire(spaceId, scratchDir, options);
    try {
      return await action();
    } finally {
      await unlock();
    }
  }

  public async acquire(
    spaceId: string,
    scratchDir: string,
    options?: LockOptions,
  ): Promise<() => Promise<void>> {
    const interval =
      options?.intervalMs ?? ScratchLockAdapter.DEFAULT_INTERVAL_MS;
    const maxWait =
      options?.maxWaitMs ?? ScratchLockAdapter.DEFAULT_MAX_WAIT_MS;
    const staleMs = options?.staleMs ?? ScratchLockAdapter.DEFAULT_STALE_MS;
    const signal = options?.signal;

    const lockPath = path.join(scratchDir, ScratchLockAdapter.LOCK_FILENAME);
    const startTime = Date.now();
    const lockToken = crypto.randomUUID();

    while (Date.now() - startTime < maxWait) {
      if (signal?.aborted) {
        throw new ScratchLockAbortedError(spaceId);
      }

      try {
        const lockInfo = JSON.stringify({
          spaceId,
          pid: process.pid,
          token: lockToken,
          acquiredAt: new Date().toISOString(),
          timestamp: Date.now(),
        });
        await fs.writeFile(lockPath, lockInfo, { flag: 'wx' });

        return async () => {
          try {
            const raw = await fs.readFile(lockPath, 'utf8');
            const parsed = JSON.parse(raw) as { token?: string };
            if (!parsed.token || parsed.token === lockToken) {
              await fs.unlink(lockPath);
            }
          } catch {
            // Lockfile may have already been cleaned
          }
        };
      } catch (err: unknown) {
        const errCode = (err as { code?: string })?.code;
        if (
          errCode === 'EEXIST' ||
          errCode === 'EPERM' ||
          errCode === 'EBUSY'
        ) {
          try {
            const stat = await fs.stat(lockPath);
            const age = Date.now() - stat.mtimeMs;
            if (age > staleMs) {
              const staleRename = `${lockPath}.stale.${process.pid}.${Date.now()}`;
              await fs.rename(lockPath, staleRename).catch(() => {});
              await fs.unlink(staleRename).catch(() => {});
              continue;
            }
          } catch {
            continue;
          }

          await new Promise((resolve) => setTimeout(resolve, interval));
        } else if (errCode === 'ENOENT') {
          await fs.mkdir(scratchDir, { recursive: true });
        } else {
          throw err;
        }
      }
    }

    throw new ScratchLockTimeoutError(spaceId, maxWait);
  }
}

export class ScratchLockAbortedError extends PagesDomainError {
  constructor(public readonly spaceId: string) {
    super(`Project lock acquisition aborted for "${spaceId}"`, {
      code: 'PROJECT_LOCK_ABORTED',
      statusCode: 499,
    });
  }
}

export class ScratchLockTimeoutError extends PagesDomainError {
  constructor(spaceId: string, maxWait: number) {
    super(
      `Project compilation lock timed out after ${maxWait}ms for project "${spaceId}". Another compilation is currently in progress.`,
      {
        code: 'PROJECT_LOCK_TIMEOUT',
        statusCode: 409,
      },
    );
  }
}

export interface CleanStats {
  scannedWorkspaces: number;
  cleanedWorkspaces: number;
  freedBytes: number;
  skippedLocked: number;
}

export interface DiskUsageOptions {
  maxAgeMs?: number;
  maxBytes?: number;
  targetBytes?: number;
}

interface ProjectDirInfo {
  spaceId: string;
  fullPath: string;
  sizeBytes: number;
  lastModifiedMs: number;
  isLocked: boolean;
}

export class DiskUsageCleaner implements OnModuleInit, OnModuleDestroy {
  private static readonly DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  private static readonly DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024;
  private static readonly DEFAULT_TARGET_BYTES = 3 * 1024 * 1024 * 1024;
  public static readonly DEFAULT_GC_INTERVAL_MS = 6 * 60 * 60 * 1000;

  private readonly logger = new Logger(DiskUsageCleaner.name);
  private gcTimer: NodeJS.Timeout | null = null;
  private gcInFlight = false;

  constructor(
    private readonly baseScratchDir: string = path.join(
      os.tmpdir(),
      'clsi-scratch',
    ),
    private readonly gcIntervalMs: number = 0,
  ) {}

  public onModuleInit(): void {
    if (!Number.isFinite(this.gcIntervalMs) || this.gcIntervalMs <= 0) return;

    this.gcTimer = setInterval(() => {
      if (this.gcInFlight) return;
      this.gcInFlight = true;
      void Promise.all([this.cleanStaleWorkspaces(), this.enforceDiskQuota()])
        .then(([stale, quota]) => {
          const totalCleaned =
            stale.cleanedWorkspaces + quota.cleanedWorkspaces;
          if (totalCleaned > 0) {
            this.logger.log(
              `Scheduled scratch GC cleaned ${totalCleaned} workspace(s), freed ${stale.freedBytes + quota.freedBytes} bytes.`,
            );
          }
        })
        .catch((err: unknown) => {
          this.logger.warn(
            `Scheduled scratch GC failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(() => {
          this.gcInFlight = false;
        });
    }, this.gcIntervalMs);
    this.gcTimer.unref();
  }

  public onModuleDestroy(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  public async cleanStaleWorkspaces(
    options?: DiskUsageOptions,
  ): Promise<CleanStats> {
    const maxAgeMs = options?.maxAgeMs ?? DiskUsageCleaner.DEFAULT_MAX_AGE_MS;
    const now = Date.now();
    const stats: CleanStats = {
      scannedWorkspaces: 0,
      cleanedWorkspaces: 0,
      freedBytes: 0,
      skippedLocked: 0,
    };

    const projects = await this.listProjects();
    stats.scannedWorkspaces = projects.length;

    for (const project of projects) {
      if (project.isLocked) {
        stats.skippedLocked++;
        continue;
      }

      const ageMs = now - project.lastModifiedMs;
      if (ageMs > maxAgeMs) {
        try {
          await fs.rm(project.fullPath, { recursive: true, force: true });
          stats.cleanedWorkspaces++;
          stats.freedBytes += project.sizeBytes;
        } catch {
          // Ignored
        }
      }
    }

    return stats;
  }

  public async enforceDiskQuota(
    options?: DiskUsageOptions,
  ): Promise<CleanStats> {
    const maxBytes = options?.maxBytes ?? DiskUsageCleaner.DEFAULT_MAX_BYTES;
    const targetBytes =
      options?.targetBytes ?? DiskUsageCleaner.DEFAULT_TARGET_BYTES;

    const stats: CleanStats = {
      scannedWorkspaces: 0,
      cleanedWorkspaces: 0,
      freedBytes: 0,
      skippedLocked: 0,
    };

    const projects = await this.listProjects();
    stats.scannedWorkspaces = projects.length;

    let totalBytes = projects.reduce((sum, p) => sum + p.sizeBytes, 0);

    if (totalBytes <= maxBytes) {
      return stats;
    }

    const sortedProjects = [...projects].sort(
      (a, b) => a.lastModifiedMs - b.lastModifiedMs,
    );

    for (const project of sortedProjects) {
      if (totalBytes <= targetBytes) {
        break;
      }

      if (project.isLocked) {
        stats.skippedLocked++;
        continue;
      }

      try {
        await fs.rm(project.fullPath, { recursive: true, force: true });
        stats.cleanedWorkspaces++;
        stats.freedBytes += project.sizeBytes;
        totalBytes -= project.sizeBytes;
      } catch {
        // Ignored
      }
    }

    return stats;
  }

  private async listProjects(): Promise<ProjectDirInfo[]> {
    try {
      const entries = await fs.readdir(this.baseScratchDir, {
        withFileTypes: true,
      });
      const projects: ProjectDirInfo[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const fullPath = path.join(this.baseScratchDir, entry.name);
        const lockPath = path.join(fullPath, '.project-lock');

        let isLocked = false;
        try {
          const lockStat = await fs.stat(lockPath);
          isLocked = Date.now() - lockStat.mtimeMs < 5 * 60 * 1000;
        } catch {
          isLocked = false;
        }

        const { sizeBytes, latestMtime } = await this.calcDirSize(fullPath);

        projects.push({
          spaceId: entry.name,
          fullPath,
          sizeBytes,
          lastModifiedMs: latestMtime,
          isLocked,
        });
      }

      return projects;
    } catch {
      return [];
    }
  }

  private async calcDirSize(
    dirPath: string,
  ): Promise<{ sizeBytes: number; latestMtime: number }> {
    let sizeBytes = 0;
    let latestMtime = 0;

    try {
      const dirStat = await fs.stat(dirPath);
      latestMtime = dirStat.mtimeMs;
    } catch {
      // Ignored
    }

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dirPath, entry.name);
        try {
          const stat = await fs.stat(full);
          if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;

          if (entry.isDirectory()) {
            const sub = await this.calcDirSize(full);
            sizeBytes += sub.sizeBytes;
            if (sub.latestMtime > latestMtime) latestMtime = sub.latestMtime;
          } else if (entry.isFile()) {
            sizeBytes += stat.size;
          }
        } catch {
          // File might have been transiently removed
        }
      }
    } catch {
      // Ignored
    }

    return { sizeBytes, latestMtime };
  }
}

export class OutputFileFinder {
  private static readonly IGNORED_NAMES = new Set([
    '.project-lock',
    '.clsi-manifest.json',
    '.latexmkrc',
  ]);

  public async find(
    scratchDir: string,
    inputFiles: string[],
  ): Promise<DiscoveredOutputFile[]> {
    const inputSet = new Set(
      inputFiles.map((f) => f.replace(/\\/g, '/').replace(/^\/+/, '')),
    );

    const discovered: DiscoveredOutputFile[] = [];
    await this.scanDir(scratchDir, '', inputSet, discovered);

    return discovered.sort((a, b) => {
      if (a.isMainPdf) return -1;
      if (b.isMainPdf) return 1;
      if (a.isLog) return -1;
      if (b.isLog) return 1;
      if (a.isSynctex) return -1;
      if (b.isSynctex) return 1;
      return a.path.localeCompare(b.path);
    });
  }

  private async scanDir(
    baseDir: string,
    relDir: string,
    inputSet: Set<string>,
    results: DiscoveredOutputFile[],
  ): Promise<void> {
    const currentDir = relDir ? path.join(baseDir, relDir) : baseDir;
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (OutputFileFinder.IGNORED_NAMES.has(entry.name)) {
        continue;
      }

      const entryRelPath = relDir
        ? `${relDir}/${entry.name}`.replace(/\\/g, '/')
        : entry.name.replace(/\\/g, '/');

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        await this.scanDir(baseDir, entryRelPath, inputSet, results);
      } else if (entry.isFile()) {
        if (!inputSet.has(entryRelPath)) {
          try {
            const stat = await fs.lstat(fullPath);
            if (stat.isSymbolicLink() || !stat.isFile()) continue;
            results.push({
              path: entryRelPath,
              size: stat.size,
              mtime: stat.mtime,
              isMainPdf: entryRelPath === 'output.pdf',
              isLog: entryRelPath === 'output.log',
              isSynctex:
                entryRelPath === 'output.synctex.gz' ||
                entryRelPath === 'output.synctex',
            });
          } catch {
            // File might have been transiently removed
          }
        }
      }
    }
  }
}
