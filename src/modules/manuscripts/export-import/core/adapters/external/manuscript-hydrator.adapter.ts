/**
 * export-import/core/adapters/external/manuscript-hydrator.adapter.ts
 * Driven Adapter reconstituting an uncompressed ZIP archive into virtual file tree nodes,
 * docstore text documents, and filestore binary media assets.
 */

import { Injectable, Logger } from '@nestjs/common';
import * as path from 'node:path';
import { IManuscriptHydratorPort } from '../../ports/manuscript-hydrator.port';
import { ArchiveEntryVo } from '../../domain/value-objects/archive-entry.vo';
import { ImportSummaryVo } from '../../domain/value-objects/import-summary.vo';
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

    for (const entry of entries) {
      const normalizedPath = '/' + entry.path.replace(/^\/+/, '');
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

      if (storageType === 'doc') {
        const text = entry.data.toString('utf8');
        const lines = text.split(/\r?\n/);

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
      const preferredNorm = '/' + preferredRootDoc.replace(/^\/+/, '');
      const match = await this.structureService.getNodeByPath(projectId, preferredNorm);
      if (match && match.type === 'DOC') {
        const updated = await this.structureService.setRootDoc(projectId, match.id);
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
}
