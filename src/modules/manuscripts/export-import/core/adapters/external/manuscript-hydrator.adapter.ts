/**
 * export-import/core/adapters/external/manuscript-hydrator.adapter.ts
 * Driven Adapter reconstituting an uncompressed ZIP archive into virtual file tree nodes,
 * docstore text documents, and filestore binary media assets.
 */

import { Injectable, Logger } from '@nestjs/common';
import * as path from 'node:path';
import { IManuscriptHydratorPort } from '@/modules/manuscripts/export-import/core/ports/manuscript-hydrator.port';
import { ArchiveEntryVo } from '@/modules/manuscripts/export-import/core/domain/value-objects/archive-entry.vo';
import { ImportSummaryVo } from '@/modules/manuscripts/export-import/core/domain/value-objects/import-summary.vo';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { FilestoreService } from '@/modules/manuscripts/filestore/filestore.service';

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.eps': 'application/postscript',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function inferMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

@Injectable()
export class ManuscriptHydratorAdapter extends IManuscriptHydratorPort {
  private readonly logger = new Logger(ManuscriptHydratorAdapter.name);

  constructor(
    private readonly structureService: StructureService,
    private readonly docstoreService: DocstoreService,
    private readonly filestoreService: FilestoreService,
  ) {
    super();
  }

  public async hydrateProjectEntries(
    projectId: string,
    entries: ArchiveEntryVo[],
    userId?: string | null,
    preferredRootDoc?: string,
  ): Promise<ImportSummaryVo> {
    let totalDocs = 0;
    let totalFiles = 0;
    let totalFolders = 0;
    const docContentsMap = new Map<string, string[]>();

    // Overleaf Parity: Detect and unwrap a single top-level wrapper directory
    // (e.g., GitHub/macOS archives where all files sit under "attention-paper/ms.tex", "attention-paper/Sections/...")
    const wrapperPrefix = this.detectSingleWrapperFolder(entries);

    for (const entry of entries) {
      let cleanRelPath = entry.path.replace(/^\/+/, '');
      if (wrapperPrefix) {
        if (cleanRelPath === wrapperPrefix) {
          continue; // Skip the wrapper folder entry itself
        }
        if (cleanRelPath.startsWith(wrapperPrefix + '/')) {
          cleanRelPath = cleanRelPath.slice(wrapperPrefix.length + 1);
        }
      }
      const normalizedPath = '/' + cleanRelPath;
      const parentDir = path.posix.dirname(normalizedPath);
      const baseName = path.posix.basename(normalizedPath);

      if (!baseName) continue;

      // Ensure parent directory hierarchy exists in structure
      if (parentDir !== '/' && parentDir !== '.') {
        await this.structureService.mkdirp(projectId, parentDir);
      }

      if (entry.isDirectory) {
        await this.structureService.mkdirp(projectId, normalizedPath);
        totalFolders++;
        continue;
      }

      const storageType = entry.getStorageType();
      const existingNode = await this.structureService.getNodeByPath(
        projectId,
        normalizedPath,
      );

      if (storageType === 'doc') {
        const text = entry.data.toString('utf8').replace(/^\uFEFF/, '');
        const lines = text
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .split('\n');

        if (existingNode && existingNode.type === 'DOC' && existingNode.docId) {
          const current = await this.docstoreService
            .getDoc(projectId, existingNode.docId)
            .catch(() => null);
          await this.docstoreService.updateDoc(projectId, existingNode.docId, {
            lines,
            version: (current?.version ?? 0) + 1,
          });
          docContentsMap.set(existingNode.docId, lines);
          totalDocs++;
          continue;
        }

        if (existingNode) {
          await this.structureService.deleteNode(projectId, existingNode.id);
        }

        const doc = await this.docstoreService.createDoc(projectId, {
          path: normalizedPath,
          lines,
        });

        await this.structureService.createNode(projectId, {
          path: normalizedPath,
          name: baseName,
          type: 'DOC',
          docId: doc._id,
        });

        docContentsMap.set(doc._id, lines);
        totalDocs++;
      } else {
        const mimeType = inferMimeType(entry.path);

        if (existingNode) {
          if (existingNode.fileId) {
            await this.filestoreService
              .deleteFile(projectId, existingNode.fileId, false)
              .catch(() => undefined);
          }
          await this.structureService.deleteNode(projectId, existingNode.id);
        }

        const file = await this.filestoreService.uploadFileFromBuffer(
          projectId,
          baseName,
          entry.data,
          mimeType,
        );

        await this.structureService.createNode(projectId, {
          path: normalizedPath,
          name: baseName,
          type: 'FILE',
          fileId: file.id,
        });

        totalFiles++;
      }
    }

    // Determine Root Document (main.tex)
    let rootDocId: string | null = null;
    let rootDocPath: string | null = null;

    if (preferredRootDoc) {
      let cleanPreferred = preferredRootDoc.replace(/^\/+/, '');
      if (wrapperPrefix && cleanPreferred.startsWith(wrapperPrefix + '/')) {
        cleanPreferred = cleanPreferred.slice(wrapperPrefix.length + 1);
      }
      const preferredNorm = '/' + cleanPreferred;
      const match = await this.structureService.getNodeByPath(
        projectId,
        preferredNorm,
      );
      if (match && match.type === 'DOC') {
        const updated = await this.structureService.setRootDoc(
          projectId,
          match.id,
        );
        rootDocId = updated.id;
        rootDocPath = updated.path;
      }
    }

    if (!rootDocId) {
      const detected = await this.structureService.autoDetectRootDoc(
        projectId,
        docContentsMap,
      );

      if (detected) {
        rootDocId = detected.id;
        rootDocPath = detected.path;
      }
    }

    return new ImportSummaryVo({
      projectId,
      totalEntries: entries.length,
      totalDocs,
      totalFiles,
      totalFolders,
      rootDocId,
      rootDocPath,
    });
  }

  /**
   * Detects when all archive entries are nested inside a single top-level wrapper folder
   * that directly contains at least one TeX document (e.g., "attention-paper/ms.tex").
   */
  private detectSingleWrapperFolder(entries: ArchiveEntryVo[]): string | null {
    const fileEntries = entries.filter((e) => !e.isDirectory);
    if (fileEntries.length === 0) return null;

    let commonTopFolder: string | null = null;
    let hasRootTexInsideWrapper = false;

    for (const entry of entries) {
      const clean = entry.path.replace(/^\/+/, '').replace(/\/+$/, '');
      if (!clean) continue;
      const segments = clean.split('/');
      const firstSegment = segments[0];

      if (commonTopFolder === null) {
        commonTopFolder = firstSegment;
      } else if (commonTopFolder !== firstSegment) {
        return null;
      }

      if (!entry.isDirectory) {
        // A file directly at root (depth 1) means there is no wrapper folder
        if (segments.length < 2) {
          return null;
        }
        // Check if there is a .tex/.ltx/.rtex file directly inside the wrapper folder (depth 2)
        if (
          segments.length === 2 &&
          /\.(tex|ltx|rtex|latex)$/i.test(segments[1])
        ) {
          hasRootTexInsideWrapper = true;
        }
      }
    }

    return hasRootTexInsideWrapper ? commonTopFolder : null;
  }
}
