/**
 * export-import/core/adapters/external/manuscript-aggregator.adapter.ts
 * Driven Adapter collecting all virtual file tree nodes, docstore text lines,
 * and filestore binary assets into a consolidated list for ZIP archiving.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { IManuscriptAggregatorPort, ExportableFileEntry } from '../../ports/manuscript-aggregator.port';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { FilestoreService } from '@/modules/manuscripts/filestore/filestore.service';
import { ClsiService } from '@/modules/manuscripts/clsi/clsi.service';
import { Readable } from 'node:stream';

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
  ): Promise<ExportableFileEntry[]> {
    const nodes = await this.structureService.getAllNodes(projectId);
    const nonFolderNodes = nodes.filter((n) => n.type !== 'FOLDER');
    const results: ExportableFileEntry[] = [];

    for (const node of nonFolderNodes) {
      // Remove leading slash for clean ZIP relative paths (e.g., /main.tex -> main.tex)
      const relPath = node.path.replace(/^\/+/, '');
      if (!relPath) continue;

      try {
        if (node.type === 'DOC' && node.docId) {
          const doc = await this.docstoreService.getDoc(projectId, node.docId);
          const textContent = (doc.lines || []).join('\n');
          results.push({
            path: relPath,
            data: Buffer.from(textContent, 'utf8'),
          });
        } else if (node.type === 'FILE' && node.fileId) {
          const streamResult = await this.filestoreService.openReadStream(projectId, node.fileId);
          const buffer = await this.streamToBuffer(streamResult.stream);
          results.push({
            path: relPath,
            data: buffer,
          });
        }
      } catch (err: any) {
        this.logger.warn(`Failed to collect entry for node ${node.id} (${node.path}): ${err.message}`);
      }
    }

    // Optionally include latest compiled PDF from CLSI build artifacts
    if (includePdf && this.clsiService) {
      try {
        const buildArtifact = await this.clsiService.readAuxFileBuffer(projectId, 'output.pdf');
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
      stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', (err) => reject(err));
    });
  }
}
