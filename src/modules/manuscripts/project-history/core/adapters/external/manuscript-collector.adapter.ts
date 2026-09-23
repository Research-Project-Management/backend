/**
 * project-history/core/adapters/external/manuscript-collector.adapter.ts
 * Driven Adapter implementing IProjectCollectorPort to aggregate current live project files.
 */

import { Injectable, Logger } from '@nestjs/common';
import { IProjectCollectorPort } from '../../ports/project-collector.port';
import { FileSnapshotVo } from '../../domain/value-objects/file-snapshot.vo';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { FilestoreService } from '@/modules/manuscripts/filestore/filestore.service';
import { DocumentUpdaterService } from '@/modules/manuscripts/document-updater/document-updater.service';

@Injectable()
export class ManuscriptCollectorAdapter extends IProjectCollectorPort {
  private readonly logger = new Logger(ManuscriptCollectorAdapter.name);

  constructor(
    private readonly structureService: StructureService,
    private readonly docstoreService: DocstoreService,
    private readonly filestoreService: FilestoreService,
    private readonly documentUpdaterService: DocumentUpdaterService,
  ) {
    super();
  }

  public async collectCurrentState(projectId: string): Promise<Map<string, FileSnapshotVo>> {
    // 1. Flush any uncommitted in-flight keystrokes to Docstore
    try {
      await this.documentUpdaterService.flushProject(projectId, true);
    } catch (err) {
      this.logger.warn(`Failed to flush project ${projectId} prior to snapshot collection: ${err}`);
    }

    // 2. Fetch all structure nodes
    const nodes = await this.structureService.getAllNodes(projectId);
    const filesMap = new Map<string, FileSnapshotVo>();

    for (const node of nodes) {
      if (node.isFolder()) {
        continue;
      }

      if (node.isDoc() && node.docId) {
        try {
          const doc = await this.docstoreService.getDoc(projectId, node.docId);
          const vo = FileSnapshotVo.createDoc(
            node.path,
            node.docId,
            doc.lines || [''],
            doc.hash || '',
            node.isRootDoc,
          );
          filesMap.set(vo.path, vo);
        } catch (error) {
          this.logger.error(`Error collecting doc ${node.docId} at path ${node.path}: ${error}`);
        }
      } else if (node.type === 'FILE' && node.fileId) {
        try {
          const fileMeta = await this.filestoreService.getFileMetadata(projectId, node.fileId);
          const hashString = fileMeta.hash ? fileMeta.hash.getValue() : (node.hash || '');
          const vo = FileSnapshotVo.createFile(
            node.path,
            node.fileId,
            hashString,
            fileMeta.sizeBytes || node.sizeBytes || 0,
          );
          filesMap.set(vo.path, vo);
        } catch (error) {
          this.logger.error(`Error collecting file ${node.fileId} at path ${node.path}: ${error}`);
        }
      }
    }

    return filesMap;
  }
}
