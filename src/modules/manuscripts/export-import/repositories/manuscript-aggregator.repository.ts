/**
 * modules/manuscripts/export-import/repositories/manuscript-aggregator.repository.ts
 * Repository collecting virtual file tree nodes, docstore text lines, and filestore
 * binary assets into a consolidated list for ZIP archiving, alongside project hydration.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IManuscriptAggregatorPort,
  ExportableFileEntry,
} from '../core/ports/manuscript-aggregator.port';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { FilestoreService } from '@/modules/manuscripts/filestore/filestore.service';
import { ClsiService } from '@/modules/manuscripts/clsi/clsi.service';
import { Readable } from 'node:stream';
import { mapWithConcurrency } from '@/core';
import type { ManuscriptNodeEntity } from '@/modules/manuscripts/structure/domain';
import { isArxivAllowed } from '../domain/archive-validator';
import { ManuscriptHydratorAdapter } from '../core/adapters/external/manuscript-hydrator.adapter';
import { EmbeddedTemplateCatalogAdapter } from '../core/adapters/storage/embedded-template-catalog.adapter';

const COLLECT_CONCURRENCY = 6;

@Injectable()
export class ManuscriptAggregatorAdapter extends IManuscriptAggregatorPort {
  private readonly logger = new Logger(ManuscriptAggregatorAdapter.name);

  constructor(
    private readonly structureService: StructureService,
    private readonly docstoreService: DocstoreService,
    private readonly filestoreService: FilestoreService,
    @Optional() private readonly clsiService?: ClsiService,
  ) {
    super();
  }

  public async collectProjectEntries(
    projectId: string,
    includePdf = false,
    cleanArxiv = false,
  ): Promise<ExportableFileEntry[]> {
    const nodes = await this.structureService.getAllNodes(projectId);
    const nonFolderNodes = nodes.filter((n) => n.type !== 'FOLDER');
    const results: ExportableFileEntry[] = [];

    const candidates = nonFolderNodes
      .map((node) => ({
        node,
        relPath: node.path.replace(/^\/+/, ''),
      }))
      .filter(
        ({ relPath }) => relPath && (!cleanArxiv || isArxivAllowed(relPath)),
      );

    const collected = await mapWithConcurrency<
      { node: ManuscriptNodeEntity; relPath: string },
      ExportableFileEntry | null
    >(
      candidates,
      COLLECT_CONCURRENCY,
      async ({
        node,
        relPath,
      }: {
        node: ManuscriptNodeEntity;
        relPath: string;
      }): Promise<ExportableFileEntry | null> => {
        try {
          if (node.type === 'DOC' && node.docId) {
            const doc = await this.docstoreService.getDoc(
              projectId,
              node.docId,
            );
            const textContent = (doc.lines || []).join('\n');
            return { path: relPath, data: Buffer.from(textContent, 'utf8') };
          }
          if (node.type === 'FILE' && node.fileId) {
            const streamResult = await this.filestoreService.openReadStream(
              projectId,
              node.fileId,
            );
            const buffer = await this.streamToBuffer(streamResult.stream);
            return { path: relPath, data: buffer };
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Failed to collect entry for node ${node.id} (${node.path}): ${errMsg}`,
          );
        }
        return null;
      },
    );
    for (const entry of collected) {
      if (entry) results.push(entry);
    }

    if (cleanArxiv && this.clsiService) {
      const hasBbl = results.some((r) => r.path.endsWith('.bbl'));
      if (!hasBbl) {
        try {
          const rootNode = nodes.find((n) => n.isRootDoc);
          const rootRelPath = rootNode
            ? rootNode.path.replace(/^\/+/, '')
            : null;
          const targetBblPath = rootRelPath
            ? rootRelPath.replace(/\.[^/.]+$/, '') + '.bbl'
            : 'output.bbl';

          const bblBuffer =
            (await this.clsiService.readAuxFileBuffer(
              projectId,
              targetBblPath,
            )) ||
            (await this.clsiService.readAuxFileBuffer(projectId, 'output.bbl'));

          if (bblBuffer && bblBuffer.length > 0) {
            results.push({
              path: targetBblPath,
              data: bblBuffer,
            });
          }
        } catch {
          // No bbl artifact available
        }
      }
    }

    if (includePdf && this.clsiService) {
      try {
        const buildArtifact = await this.clsiService.readAuxFileBuffer(
          projectId,
          'output.pdf',
        );
        if (buildArtifact) {
          results.push({
            path: 'output.pdf',
            data: buildArtifact,
          });
        }
      } catch {
        // PDF compilation artifact not available or never compiled; skip silently
      }
    }

    return results;
  }

  public async collectLazyProjectEntries(
    projectId: string,
    includePdf = false,
    cleanArxiv = false,
  ): Promise<ExportableFileEntry[]> {
    const nodes = await this.structureService.getAllNodes(projectId);
    const nonFolderNodes = nodes.filter((n) => n.type !== 'FOLDER');
    const results: ExportableFileEntry[] = [];

    const candidates = nonFolderNodes
      .map((node) => ({
        node,
        relPath: node.path.replace(/^\/+/, ''),
      }))
      .filter(
        ({ relPath }) => relPath && (!cleanArxiv || isArxivAllowed(relPath)),
      );

    for (const { node, relPath } of candidates) {
      if (node.type === 'DOC' && node.docId) {
        const docId = node.docId;
        results.push({
          path: relPath,
          getData: async () => {
            const doc = await this.docstoreService.getDoc(projectId, docId);
            const textContent = (doc.lines || []).join('\n');
            return Buffer.from(textContent, 'utf8');
          },
        });
      } else if (node.type === 'FILE' && node.fileId) {
        const fileId = node.fileId;
        results.push({
          path: relPath,
          getData: async () => {
            const streamResult = await this.filestoreService.openReadStream(
              projectId,
              fileId,
            );
            return this.streamToBuffer(streamResult.stream);
          },
        });
      }
    }

    if (cleanArxiv && this.clsiService) {
      const hasBbl = results.some((r) => r.path.endsWith('.bbl'));
      if (!hasBbl) {
        results.push({
          path: 'output.bbl',
          getData: async () => {
            const bblBuffer = await this.clsiService!.readAuxFileBuffer(
              projectId,
              'output.bbl',
            );
            return bblBuffer || Buffer.alloc(0);
          },
        });
      }
    }

    if (includePdf && this.clsiService) {
      results.push({
        path: 'output.pdf',
        getData: async () => {
          const pdfBuffer = await this.clsiService!.readAuxFileBuffer(
            projectId,
            'output.pdf',
          );
          return pdfBuffer || Buffer.alloc(0);
        },
      });
    }

    return results;
  }

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      stream.on('data', (chunk) =>
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
      );
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', (err) => reject(err));
    });
  }
}

export {
  ManuscriptAggregatorAdapter as ManuscriptAggregatorRepository,
  ManuscriptHydratorAdapter,
  EmbeddedTemplateCatalogAdapter,
};
