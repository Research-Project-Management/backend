/**
 * clsi/adapters/workspace-fs.adapters.ts
 * Driven File-System & Scratch Workspace Adapters for CLSI:
 * - ProjectLockManager & ProjectLockTimeoutError (.project-lock concurrency guard)
 * - DiskUsageCleaner (LRU scratch directory garbage collection)
 * - OverleafOutputFileFinder (Port: IOutputFileFinder)
 * - createZipStreamFromDisk (PKZIP disk artifact stream helper)
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import {
  createPkZipStream,
  PkZipEntry,
} from '../../core/utils/pkzip-builder.util';
import { IOutputFileFinder, DiscoveredOutputFile } from '../domain';

// ─────────────────────────────────────────────────────────────────
// Project Lock Manager (.project-lock)
// ─────────────────────────────────────────────────────────────────

export interface LockOptions {
  intervalMs?: number;
  maxWaitMs?: number;
  staleMs?: number;
}

export class ProjectLockManager {
  private static readonly LOCK_FILENAME = '.project-lock';
  private static readonly DEFAULT_INTERVAL_MS = 100;
  private static readonly DEFAULT_MAX_WAIT_MS = 15000;
  private static readonly DEFAULT_STALE_MS = 5 * 60 * 1000;

  public async runWithLock<T>(
    projectId: string,
    scratchDir: string,
    action: () => Promise<T>,
    options?: LockOptions,
  ): Promise<T> {
    const unlock = await this.acquire(projectId, scratchDir, options);
    try {
      return await action();
    } finally {
      await unlock();
    }
  }

  public async acquire(
    projectId: string,
    scratchDir: string,
    options?: LockOptions,
  ): Promise<() => Promise<void>> {
    const interval =
      options?.intervalMs ?? ProjectLockManager.DEFAULT_INTERVAL_MS;
    const maxWait =
      options?.maxWaitMs ?? ProjectLockManager.DEFAULT_MAX_WAIT_MS;
    const staleMs = options?.staleMs ?? ProjectLockManager.DEFAULT_STALE_MS;

    const lockPath = path.join(scratchDir, ProjectLockManager.LOCK_FILENAME);
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      try {
        const lockInfo = JSON.stringify({
          projectId,
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          timestamp: Date.now(),
        });
        await fs.writeFile(lockPath, lockInfo, { flag: 'wx' });

        return async () => {
          try {
            await fs.unlink(lockPath);
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
              await fs.unlink(lockPath);
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

    throw new ProjectLockTimeoutError(projectId, maxWait);
  }
}

export class ProjectLockTimeoutError extends Error {
  constructor(projectId: string, maxWait: number) {
    super(
      `Project compilation lock timed out after ${maxWait}ms for project "${projectId}". Another compilation is currently in progress.`,
    );
    this.name = 'ProjectLockTimeoutError';
  }
}

// ─────────────────────────────────────────────────────────────────
// Disk Usage Cleaner (LRU Scratch GC)
// ─────────────────────────────────────────────────────────────────

export interface CleanStats {
  scannedProjects: number;
  cleanedProjects: number;
  freedBytes: number;
  skippedLocked: number;
}

export interface DiskUsageOptions {
  maxAgeMs?: number;
  maxBytes?: number;
  targetBytes?: number;
}

interface ProjectDirInfo {
  projectId: string;
  fullPath: string;
  sizeBytes: number;
  lastModifiedMs: number;
  isLocked: boolean;
}

export class DiskUsageCleaner {
  private static readonly DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  private static readonly DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024;
  private static readonly DEFAULT_TARGET_BYTES = 3 * 1024 * 1024 * 1024;

  constructor(private readonly baseScratchDir: string = '/tmp/clsi-scratch') {}

  public async cleanStaleProjects(
    options?: DiskUsageOptions,
  ): Promise<CleanStats> {
    const maxAgeMs = options?.maxAgeMs ?? DiskUsageCleaner.DEFAULT_MAX_AGE_MS;
    const now = Date.now();
    const stats: CleanStats = {
      scannedProjects: 0,
      cleanedProjects: 0,
      freedBytes: 0,
      skippedLocked: 0,
    };

    const projects = await this.listProjects();
    stats.scannedProjects = projects.length;

    for (const project of projects) {
      if (project.isLocked) {
        stats.skippedLocked++;
        continue;
      }

      const ageMs = now - project.lastModifiedMs;
      if (ageMs > maxAgeMs) {
        try {
          await fs.rm(project.fullPath, { recursive: true, force: true });
          stats.cleanedProjects++;
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
      scannedProjects: 0,
      cleanedProjects: 0,
      freedBytes: 0,
      skippedLocked: 0,
    };

    const projects = await this.listProjects();
    stats.scannedProjects = projects.length;

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
        stats.cleanedProjects++;
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
          projectId: entry.name,
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

// ─────────────────────────────────────────────────────────────────
// Output File Finder (Overleaf OutputFileFinder parity)
// ─────────────────────────────────────────────────────────────────

export class OverleafOutputFileFinder implements IOutputFileFinder {
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
      if (OverleafOutputFileFinder.IGNORED_NAMES.has(entry.name)) {
        continue;
      }

      const entryRelPath = relDir
        ? `${relDir}/${entry.name}`.replace(/\\/g, '/')
        : entry.name.replace(/\\/g, '/');

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await this.scanDir(baseDir, entryRelPath, inputSet, results);
      } else if (entry.isFile()) {
        if (!inputSet.has(entryRelPath)) {
          try {
            const stat = await fs.stat(fullPath);
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

// ─────────────────────────────────────────────────────────────────
// PKZIP Disk Artifact Stream Helper
// ─────────────────────────────────────────────────────────────────

export interface ZipDiskEntry {
  fullPath: string;
  relPath: string;
  date?: Date;
}

export function createZipStreamFromDisk(files: ZipDiskEntry[]): Readable {
  const pkEntries: PkZipEntry[] = files.map((entry) => ({
    path: entry.relPath,
    date: entry.date,
    getData: async () => {
      try {
        return await fs.readFile(entry.fullPath);
      } catch {
        return null;
      }
    },
  }));

  return createPkZipStream(pkEntries);
}
