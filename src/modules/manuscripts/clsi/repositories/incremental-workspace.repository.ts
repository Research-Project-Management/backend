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
import { createPkZipStream, PkZipEntry } from '@/modules/manuscripts/core';
import { mapWithConcurrency } from '@/core';

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
    if (safeProjectId !== projectId) {
      const suffix = crypto
        .createHash('sha256')
        .update(projectId)
        .digest('hex')
        .slice(0, 8);
      return path.join(this.baseScratchDir, `${safeProjectId}_${suffix}`);
    }
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

    // Parallelize file synchronization with bounded concurrency (16 workers)
    const syncResults = await mapWithConcurrency(files, 16, async (file) => {
      const sanitizedRelPath = SafePath.sanitizeRelativePath(file.path);
      const targetPath = await SafePath.assertSafeWorkspacePath(
        scratchDir,
        sanitizedRelPath,
      );
      const contentBuffer = Buffer.isBuffer(file.content)
        ? file.content
        : Buffer.from(file.content, 'utf8');
      const contentHash = file.hash || this.computeHash(contentBuffer);
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
        return {
          path: sanitizedRelPath,
          hash: contentHash,
          status: 'unchanged' as const,
        };
      } else {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, contentBuffer);
        return {
          path: sanitizedRelPath,
          hash: contentHash,
          status: 'written' as const,
        };
      }
    });

    for (const r of syncResults) {
      currentFileKeys.add(r.path);
      newManifestFiles[r.path] = r.hash;
      if (r.status === 'unchanged') unchanged++;
      else written++;
    }

    for (const oldRelPath of Object.keys(manifest.files)) {
      if (!currentFileKeys.has(oldRelPath)) {
        try {
          const oldFilePath = SafePath.resolveSafePath(scratchDir, oldRelPath);
          await fs.unlink(oldFilePath);
          deleted++;
        } catch {}
      }
    }

    manifest.files = newManifestFiles;
    await this.writeManifest(scratchDir, manifest);

    return { written, unchanged, deleted };
  }

  public async cleanScratch(projectId: string): Promise<void> {
    const scratchDir = this.getScratchDir(projectId);
    try {
      const entries = await fs.readdir(scratchDir, { withFileTypes: true });
      await Promise.allSettled(
        entries
          .filter((entry) => entry.name !== '.project-lock')
          .map((entry) =>
            fs.rm(path.join(scratchDir, entry.name), {
              recursive: true,
              force: true,
            }),
          ),
      );
    } catch {
      // Ignored if directory doesn't exist yet
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
        if (entry.isFile() && !entry.isSymbolicLink()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (AUX_EXTENSIONS.has(ext)) {
            const fullPath = path.join(scratchDir, entry.name);
            const stat = await fs.lstat(fullPath);
            if (!stat.isSymbolicLink() && stat.isFile()) {
              results.push({
                name: entry.name,
                size: stat.size,
                ext,
              });
            }
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
      const safePath = await SafePath.assertSafeWorkspacePath(
        scratchDir,
        filename,
      );
      const ext = path.extname(filename).toLowerCase();
      if (!AUX_EXTENSIONS.has(ext) && !filename.toLowerCase().endsWith('.synctex.gz')) {
        return null;
      }
      const stat = await fs.lstat(safePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
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
      const safePath = await SafePath.assertSafeWorkspacePath(
        scratchDir,
        filename,
      );
      const stat = await fs.lstat(safePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return null;
      }
      return await fs.readFile(safePath);
    } catch {
      return null;
    }
  }
}

export {
  type LockOptions,
  ProjectLockManager,
  ProjectLockTimeoutError,
  type CleanStats,
  type DiskUsageOptions,
  DiskUsageCleaner,
  OverleafOutputFileFinder,
  type ZipDiskEntry,
  createZipStreamFromDisk,
} from '../adapters/workspace-fs.adapters';
