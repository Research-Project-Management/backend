/**
 * modules/manuscripts/clsi/repositories/incremental-workspace.repository.ts
 * Repository managing local filesystem scratch workspaces with Overleaf ResourceWriter
 * incremental MD5 hashing, auxiliary artifact preservation, project locks, disk usage cleaning,
 * output file discovery, and PKZIP streaming.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { Readable } from 'stream';
import {
  IWorkspaceManager,
  WorkspaceFile,
  WorkspaceSyncStats,
  AuxFileInfo,
  IOutputFileFinder,
  DiscoveredOutputFile,
} from '../domain/clsi-ports';
import { SafePath } from '../domain/safe-path';
import {
  buildPkZipBuffer,
  createPkZipStream,
  PkZipEntry,
  sanitizePkZipPath,
} from '@/modules/manuscripts/core';

export interface ProjectManifest {
  version: number;
  files: Record<string, string>;
  lastUpdated: string;
}

const MANIFEST_FILENAME = '.clsi-manifest.json';
const AUX_EXTENSIONS = new Set([
  '.pdf',
  '.aux',
  '.bbl',
  '.blg',
  '.log',
  '.out',
  '.toc',
  '.lof',
  '.lot',
  '.fls',
  '.fdb_latexmk',
  '.synctex',
  '.synctex.gz',
  '.nav',
  '.snm',
  '.vrb',
  '.idx',
  '.ind',
  '.ilg',
  '.bcf',
  '.run.xml',
  '.xdv',
  '.dvi',
  '.glg',
  '.glo',
  '.gls',
  '.ist',
]);

const PRE_COMPILE_PURGE_FILES = [
  'output.pdf',
  'output.log',
  'output.stdout',
  'output.stderr',
  'output.synctex',
  'output.synctex.gz',
  'output.fdb_latexmk',
  '.fdb_latexmk',
  'output.fls',
];

export class OverleafIncrementalWorkspace implements IWorkspaceManager {
  constructor(
    private readonly baseScratchDir: string = path.join(
      os.tmpdir(),
      'clsi-scratch',
    ),
  ) {}

  private computeHash(content: string | Buffer): string {
    return crypto.createHash('md5').update(content).digest('hex');
  }

  public getScratchDir(projectId: string): string {
    const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.baseScratchDir, safeProjectId);
  }

  public async ensureScratch(projectId: string): Promise<string> {
    const scratchDir = this.getScratchDir(projectId);
    await fs.mkdir(scratchDir, { recursive: true });
    return scratchDir;
  }

  private async readManifest(scratchDir: string): Promise<ProjectManifest> {
    const manifestPath = path.join(scratchDir, MANIFEST_FILENAME);
    try {
      const data = await fs.readFile(manifestPath, 'utf8');
      return JSON.parse(data) as ProjectManifest;
    } catch {
      return { version: 1, files: {}, lastUpdated: new Date().toISOString() };
    }
  }

  private async writeManifest(
    scratchDir: string,
    manifest: ProjectManifest,
  ): Promise<void> {
    const manifestPath = path.join(scratchDir, MANIFEST_FILENAME);
    manifest.lastUpdated = new Date().toISOString();
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  public async syncFiles(
    projectId: string,
    files: WorkspaceFile[],
  ): Promise<WorkspaceSyncStats> {
    const scratchDir = await this.ensureScratch(projectId);
    const manifest = await this.readManifest(scratchDir);

    let written = 0;
    let unchanged = 0;
    let deleted = 0;

    const currentFileKeys = new Set<string>();
    const newManifestFiles: Record<string, string> = {};

    for (const file of files) {
      const sanitizedRelPath = SafePath.sanitizeRelativePath(file.path);
      currentFileKeys.add(sanitizedRelPath);

      const targetPath = SafePath.resolveSafePath(scratchDir, sanitizedRelPath);
      const contentBuffer = Buffer.isBuffer(file.content)
        ? file.content
        : Buffer.from(file.content, 'utf8');

      const contentHash = file.hash || this.computeHash(contentBuffer);
      newManifestFiles[sanitizedRelPath] = contentHash;

      const cachedHash = manifest.files[sanitizedRelPath];
      let fileExists = false;
      if (cachedHash === contentHash) {
        try {
          await fs.access(targetPath);
          fileExists = true;
        } catch {
          fileExists = false;
        }
      }

      if (cachedHash === contentHash && fileExists) {
        unchanged++;
      } else {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, contentBuffer);
        written++;
      }
    }

    for (const oldRelPath of Object.keys(manifest.files)) {
      if (!currentFileKeys.has(oldRelPath)) {
        try {
          const oldFilePath = SafePath.resolveSafePath(scratchDir, oldRelPath);
          await fs.unlink(oldFilePath);
          deleted++;
        } catch {
          // File might already be gone
        }
      }
    }

    manifest.files = newManifestFiles;
    await this.writeManifest(scratchDir, manifest);

    return { written, unchanged, deleted };
  }

  public async cleanScratch(projectId: string): Promise<void> {
    const scratchDir = this.getScratchDir(projectId);
    try {
      await fs.rm(scratchDir, { recursive: true, force: true });
    } catch {
      // Ignored
    }
  }

  public async purgeExtraneousFiles(
    projectId: string,
    inputFiles: string[],
  ): Promise<void> {
    const scratchDir = this.getScratchDir(projectId);

    for (const target of PRE_COMPILE_PURGE_FILES) {
      try {
        await fs.unlink(path.join(scratchDir, target));
      } catch {
        // File might not exist
      }
    }

    try {
      const files = await fs.readdir(scratchDir);
      for (const file of files) {
        if (file.endsWith('.fdb_latexmk') || file.endsWith('.fls')) {
          await fs.unlink(path.join(scratchDir, file)).catch(() => {});
        }
      }
    } catch {
      // Ignored
    }

    const inputSet = new Set(
      inputFiles.map((f) => f.replace(/\\/g, '/').replace(/^\/+/, '')),
    );

    await this.cleanExtraneousDir(scratchDir, '', inputSet);
  }

  private isPreservedArtifact(relPath: string, fileName: string): boolean {
    const ext = path.extname(fileName).toLowerCase();
    if (AUX_EXTENSIONS.has(ext)) return true;
    if (
      fileName === MANIFEST_FILENAME ||
      fileName === '.project-lock' ||
      fileName === '.latexmkrc'
    ) {
      return true;
    }

    if (
      fileName.startsWith('output-figure') ||
      ext === '.dpth' ||
      ext === '.md5'
    ) {
      return true;
    }

    if (
      relPath.includes('_minted-') ||
      ext === '.pygstyle' ||
      ext === '.pygtex'
    ) {
      return true;
    }

    if (fileName.endsWith('-eps-converted-to.pdf')) {
      return true;
    }

    if (relPath.startsWith('cache/') || relPath.startsWith('figure/')) {
      return true;
    }

    return false;
  }

  private async cleanExtraneousDir(
    baseDir: string,
    relDir: string,
    inputSet: Set<string>,
  ): Promise<void> {
    const currentDir = relDir ? path.join(baseDir, relDir) : baseDir;
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryRelPath = relDir
        ? `${relDir}/${entry.name}`.replace(/\\/g, '/')
        : entry.name.replace(/\\/g, '/');
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await this.cleanExtraneousDir(baseDir, entryRelPath, inputSet);
        try {
          const remaining = await fs.readdir(fullPath);
          if (
            remaining.length === 0 &&
            !entryRelPath.includes('_minted-') &&
            entryRelPath !== 'cache' &&
            entryRelPath !== 'figure'
          ) {
            await fs.rmdir(fullPath);
          }
        } catch {
          // Ignored
        }
      } else if (entry.isFile()) {
        if (
          !inputSet.has(entryRelPath) &&
          !this.isPreservedArtifact(entryRelPath, entry.name)
        ) {
          try {
            await fs.unlink(fullPath);
          } catch {
            // Ignored
          }
        }
      }
    }
  }

  public async listAuxFiles(projectId: string): Promise<AuxFileInfo[]> {
    const scratchDir = this.getScratchDir(projectId);
    try {
      const entries = await fs.readdir(scratchDir, { withFileTypes: true });
      const results: AuxFileInfo[] = [];

      for (const entry of entries) {
        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (AUX_EXTENSIONS.has(ext)) {
            const stat = await fs.stat(path.join(scratchDir, entry.name));
            results.push({
              name: entry.name,
              size: stat.size,
              ext,
            });
          }
        }
      }

      return results;
    } catch {
      return [];
    }
  }

  public async readAuxFile(
    projectId: string,
    filename: string,
  ): Promise<Buffer | null> {
    const scratchDir = this.getScratchDir(projectId);
    try {
      const safePath = SafePath.resolveSafePath(scratchDir, filename);
      const ext = path.extname(filename).toLowerCase();
      if (!AUX_EXTENSIONS.has(ext)) {
        return null;
      }
      return await fs.readFile(safePath);
    } catch {
      return null;
    }
  }

  public async readArtifact(
    projectId: string,
    filename: string,
  ): Promise<Buffer | null> {
    const scratchDir = this.getScratchDir(projectId);
    try {
      const safePath = SafePath.resolveSafePath(scratchDir, filename);
      return await fs.readFile(safePath);
    } catch {
      return null;
    }
  }
}

export { OverleafIncrementalWorkspace as IncrementalWorkspaceRepository };

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

    throw new Error(
      `Project compilation lock timed out after ${maxWait}ms for project "${projectId}". Another compilation is currently in progress.`,
    );
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
// PKZIP Artifact Stream Helpers
// ─────────────────────────────────────────────────────────────────

export interface ZipFileEntry {
  path: string;
  data: string | Buffer;
  date?: Date;
}

export interface ZipDiskEntry {
  fullPath: string;
  relPath: string;
  date?: Date;
}

export type ZipEntry = ZipFileEntry | ZipDiskEntry;

function isDiskEntry(entry: ZipEntry): entry is ZipDiskEntry {
  return 'fullPath' in entry && 'relPath' in entry;
}

export function sanitizeZipPath(relPath: string): string {
  return sanitizePkZipPath(relPath);
}

export function createZipStreamFromDisk(files: ZipDiskEntry[]): Readable {
  return createZipStream(files);
}

export function createZipStream(entries: ZipEntry[]): Readable {
  const pkEntries: PkZipEntry[] = entries.map((entry) => {
    if (isDiskEntry(entry)) {
      return {
        path: entry.relPath,
        date: entry.date,
        getData: async () => {
          try {
            return await fs.readFile(entry.fullPath);
          } catch {
            return null;
          }
        },
      };
    }
    return {
      path: entry.path,
      data: entry.data,
      date: entry.date,
    };
  });

  return createPkZipStream(pkEntries);
}

export function buildZipArchive(entries: ZipFileEntry[]): Buffer {
  return buildPkZipBuffer(entries);
}
