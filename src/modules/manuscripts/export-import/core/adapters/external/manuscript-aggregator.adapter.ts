/**
 * export-import/core/adapters/external/manuscript-aggregator.adapter.ts
 * Driven Adapter collecting all virtual file tree nodes, docstore text lines,
 * and filestore binary assets into a consolidated list for ZIP archiving.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IManuscriptAggregatorPort,
  ExportableFileEntry,
} from '../../ports/manuscript-aggregator.port';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { FilestoreService } from '@/modules/manuscripts/filestore/filestore.service';
import { ClsiService } from '@/modules/manuscripts/clsi/clsi.service';
import { Readable } from 'node:stream';
import { mapWithConcurrency } from '@/core/utils/concurrency.util';
import type { ManuscriptNodeEntity } from '@/modules/manuscripts/structure/core/domain/manuscript-node.entity';

const COLLECT_CONCURRENCY = 6;

const ARXIV_ALLOWED_EXTENSIONS = new Set([
  'tex',
  'ltx',
  'sty',
  'cls',
  'bst',
  'def',
  'fd',
  'cfg',
  'bbx',
  'cbx',
  'bib',
  'bbl',
  'png',
  'jpg',
  'jpeg',
  'pdf',
  'eps',
  'ps',
  'svg',
  'csv',
  'dat',
  'txt',
]);

function isArxivAllowed(relPath: string): boolean {
  const clean = relPath.trim().toLowerCase();
  const base = clean.split('/').pop() || '';
  if (base.startsWith('.') || base.startsWith('__macosx')) return false;
  if (/\.(aux|log|out|synctex\.gz|toc|lof|lot|fls|fdb_latexmk)$/i.test(base))
    return false;
  const ext = base.split('.').pop() || '';
  return ARXIV_ALLOWED_EXTENSIONS.has(ext);
}

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
        // Remove leading slash for clean ZIP relative paths (e.g., /main.tex -> main.tex)
        relPath: node.path.replace(/^\/+/, ''),
      }))
      .filter(
        ({ relPath }) => relPath && (!cleanArxiv || isArxivAllowed(relPath)),
      );

    // Bounded parallel I/O: ceil(N / limit) rounds instead of N sequential
    // round-trips; input order (and thus ZIP entry order) is preserved.
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
        } catch (err: any) {
          this.logger.warn(
            `Failed to collect entry for node ${node.id} (${node.path}): ${err.message}`,
          );
        }
        return null;
      },
    );
    for (const entry of collected) {
      if (entry) results.push(entry);
    }

    // For arXiv submissions: include compiled .bbl if available and not already in entries
    if (cleanArxiv && this.clsiService) {
      const hasBbl = results.some((r) => r.path.endsWith('.bbl'));
      if (!hasBbl) {
        try {
          const bblBuffer = await this.clsiService.readAuxFileBuffer(
            projectId,
            'output.bbl',
          );
          if (bblBuffer && bblBuffer.length > 0) {
            results.push({
              path: 'output.bbl',
              data: bblBuffer,
            });
          }
        } catch {
          // No bbl artifact available
        }
      }
    }

    // Optionally include latest compiled PDF from CLSI build artifacts
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
