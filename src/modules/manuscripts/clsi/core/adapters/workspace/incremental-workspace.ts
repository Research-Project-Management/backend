/**
 * modules/manuscripts/clsi/core/adapters/workspace/incremental-workspace.ts
 * Implements IWorkspaceManager with Overleaf ResourceWriter incremental hashing.
 * Retains project auxiliary files (.aux, .bbl, .toc, .fdb_latexmk) across builds
 * and avoids rewriting files whose MD5 hash has not changed (preserving mtime).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  IWorkspaceManager,
  WorkspaceFile,
  WorkspaceSyncStats,
  AuxFileInfo,
} from '../../ports/workspace.port';
import { SafePathUtil } from './safe-path.util';

interface ProjectManifest {
  version: number;
  files: Record<string, string>;
  lastUpdated: string;
}

const MANIFEST_FILENAME = '.clsi-manifest.json';
const AUX_EXTENSIONS = new Set([
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
  constructor(private readonly baseScratchDir: string = '/tmp/clsi-scratch') {}

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
    manifest: ProjectManifest
  ): Promise<void> {
    const manifestPath = path.join(scratchDir, MANIFEST_FILENAME);
    manifest.lastUpdated = new Date().toISOString();
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  public async syncFiles(
    projectId: string,
    files: WorkspaceFile[]
  ): Promise<WorkspaceSyncStats> {
    const scratchDir = await this.ensureScratch(projectId);
    const manifest = await this.readManifest(scratchDir);

    let written = 0;
    let unchanged = 0;
    let deleted = 0;

    const currentFileKeys = new Set<string>();
    const newManifestFiles: Record<string, string> = {};

    for (const file of files) {
      const sanitizedRelPath = SafePathUtil.sanitizeRelativePath(file.path);
      currentFileKeys.add(sanitizedRelPath);

      const targetPath = SafePathUtil.resolveSafePath(scratchDir, sanitizedRelPath);
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
        // OVERLEAF OPTIMIZATION: Do not touch file, preserving filesystem mtime
        unchanged++;
      } else {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, contentBuffer);
        written++;
      }
    }

    // Delete removed files that were previously tracked in manifest
    for (const oldRelPath of Object.keys(manifest.files)) {
      if (!currentFileKeys.has(oldRelPath)) {
        try {
          const oldFilePath = SafePathUtil.resolveSafePath(scratchDir, oldRelPath);
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
    inputFiles: string[]
  ): Promise<void> {
    const scratchDir = this.getScratchDir(projectId);

    // 1. Purge previous compile targets to prevent stale output retention
    for (const target of PRE_COMPILE_PURGE_FILES) {
      try {
        await fs.unlink(path.join(scratchDir, target));
      } catch {
        // File might not exist
      }
    }

    // 2. Scan workspace and remove extraneous files not in inputFiles and not in preserved whitelist
    const inputSet = new Set(
      inputFiles.map((f) => f.replace(/\\/g, '/').replace(/^\/+/, ''))
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

    // TikZ externalization: output-figure* or *.dpth / *.md5
    if (fileName.startsWith('output-figure') || ext === '.dpth' || ext === '.md5') {
      return true;
    }

    // Minted cache: _minted-* or *.pygstyle / *.pygtex
    if (relPath.includes('_minted-') || ext === '.pygstyle' || ext === '.pygtex') {
      return true;
    }

    // Epstopdf: *-eps-converted-to.pdf
    if (fileName.endsWith('-eps-converted-to.pdf')) {
      return true;
    }

    // Knitr cache/figure dirs
    if (relPath.startsWith('cache/') || relPath.startsWith('figure/')) {
      return true;
    }

    return false;
  }

  private async cleanExtraneousDir(
    baseDir: string,
    relDir: string,
    inputSet: Set<string>
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
        if (!inputSet.has(entryRelPath) && !this.isPreservedArtifact(entryRelPath, entry.name)) {
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
    filename: string
  ): Promise<Buffer | null> {
    const scratchDir = this.getScratchDir(projectId);
    try {
      const safePath = SafePathUtil.resolveSafePath(scratchDir, filename);
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
    filename: string
  ): Promise<Buffer | null> {
    const scratchDir = this.getScratchDir(projectId);
    try {
      const safePath = SafePathUtil.resolveSafePath(scratchDir, filename);
      return await fs.readFile(safePath);
    } catch {
      return null;
    }
  }
}
