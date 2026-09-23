/**
 * modules/manuscripts/clsi/core/adapters/workspace/disk-usage.cleaner.ts
 * Manages LRU project scratch directory garbage collection to prevent disk saturation.
 * Matches Overleaf CLSI DiskUsageCleaner.js semantics.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface CleanStats {
  scannedProjects: number;
  cleanedProjects: number;
  freedBytes: number;
  skippedLocked: number;
}

export interface DiskUsageOptions {
  maxAgeMs?: number; // Default: 7 days
  maxBytes?: number; // Default: 5GB
  targetBytes?: number; // Default: 3GB
}

interface ProjectDirInfo {
  projectId: string;
  fullPath: string;
  sizeBytes: number;
  lastModifiedMs: number;
  isLocked: boolean;
}

export class DiskUsageCleaner {
  private static readonly DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  private static readonly DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
  private static readonly DEFAULT_TARGET_BYTES = 3 * 1024 * 1024 * 1024; // 3 GB

  constructor(private readonly baseScratchDir: string = '/tmp/clsi-scratch') {}

  /**
   * Scans scratch directory and cleans projects that have been inactive
   * longer than maxAgeMs, skipping any project with an active .project-lock.
   */
  public async cleanStaleProjects(options?: DiskUsageOptions): Promise<CleanStats> {
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

  /**
   * Enforces disk quota by evicting oldest projects first (LRU order)
   * until total disk usage falls below targetBytes.
   */
  public async enforceDiskQuota(options?: DiskUsageOptions): Promise<CleanStats> {
    const maxBytes = options?.maxBytes ?? DiskUsageCleaner.DEFAULT_MAX_BYTES;
    const targetBytes = options?.targetBytes ?? DiskUsageCleaner.DEFAULT_TARGET_BYTES;

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

    // Sort projects by LRU (oldest lastModifiedMs first)
    const sortedProjects = [...projects].sort(
      (a, b) => a.lastModifiedMs - b.lastModifiedMs
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

  /**
   * Recursively computes directory size and returns project metadata.
   */
  private async listProjects(): Promise<ProjectDirInfo[]> {
    try {
      const entries = await fs.readdir(this.baseScratchDir, { withFileTypes: true });
      const projects: ProjectDirInfo[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const fullPath = path.join(this.baseScratchDir, entry.name);
        const lockPath = path.join(fullPath, '.project-lock');

        let isLocked = false;
        try {
          const lockStat = await fs.stat(lockPath);
          // If lock exists and is less than 5 minutes old, project is currently active
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
    dirPath: string
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
