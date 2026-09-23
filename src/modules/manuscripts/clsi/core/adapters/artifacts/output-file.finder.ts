/**
 * modules/manuscripts/clsi/core/adapters/artifacts/output-file.finder.ts
 * Discovers dynamically generated files in the scratch directory following compilation.
 * Mirrors Overleaf CLSI OutputFileFinder.js:
 * scans directory, filters out incoming input resources, and catalogs newly created artifacts.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  IOutputFileFinder,
  DiscoveredOutputFile,
} from '../../ports/artifacts.port';

export class OverleafOutputFileFinder implements IOutputFileFinder {
  private static readonly IGNORED_NAMES = new Set([
    '.project-lock',
    '.clsi-manifest.json',
    '.latexmkrc',
  ]);

  public async find(
    scratchDir: string,
    inputFiles: string[]
  ): Promise<DiscoveredOutputFile[]> {
    const inputSet = new Set(
      inputFiles.map((f) => f.replace(/\\/g, '/').replace(/^\/+/, ''))
    );

    const discovered: DiscoveredOutputFile[] = [];
    await this.scanDir(scratchDir, '', inputSet, discovered);

    // Predictable sorting: output.pdf first, output.log next, then alphabetical
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
    results: DiscoveredOutputFile[]
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
        // Only include if NOT in original input files
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
