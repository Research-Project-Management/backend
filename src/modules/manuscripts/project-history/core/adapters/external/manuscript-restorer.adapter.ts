/**
 * project-history/core/adapters/external/manuscript-restorer.adapter.ts
 * Driven Adapter implementing IProjectRestorerPort to restore project structure and docstore to a historical snapshot.
 */

import { Injectable, Logger } from '@nestjs/common';
import * as pathPosix from 'node:path/posix';
import { IProjectRestorerPort, RestoreResult } from '../../ports/project-restorer.port';
import { Snapshot } from '../../domain/entities/snapshot.entity';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { DocumentUpdaterService } from '@/modules/manuscripts/document-updater/document-updater.service';
import { ManuscriptNodeEntity } from '@/modules/manuscripts/structure/core/domain/manuscript-node.entity';

@Injectable()
export class ManuscriptRestorerAdapter extends IProjectRestorerPort {
  private readonly logger = new Logger(ManuscriptRestorerAdapter.name);

  constructor(
    private readonly structureService: StructureService,
    private readonly docstoreService: DocstoreService,
    private readonly documentUpdaterService: DocumentUpdaterService,
  ) {
    super();
  }

  public async restoreToState(projectId: string, snapshot: Snapshot): Promise<RestoreResult> {
    // 1. Flush any active buffers first
    try {
      await this.documentUpdaterService.flushProject(projectId, true);
    } catch (err) {
      this.logger.warn(`Failed to flush project ${projectId} prior to restore: ${err}`);
    }

    const currentNodes = await this.structureService.getAllNodes(projectId);
    const currentByPath = new Map<string, ManuscriptNodeEntity>(
      currentNodes.map((n: ManuscriptNodeEntity) => [n.path, n]),
    );
    const snapshotFiles = snapshot.files;
    const restoredDocIds: string[] = [];

    // 2. Remove files present in current tree that do not exist in the snapshot
    for (const node of currentNodes) {
      if (!node.isFolder() && !snapshotFiles.has(node.path)) {
        try {
          await this.structureService.deleteNode(projectId, node.id);
        } catch (err) {
          this.logger.warn(`Could not delete post-snapshot node ${node.path} (${node.id}): ${err}`);
        }
      }
    }

    // 3. Restore each file from snapshot
    for (const [filePath, fileVo] of snapshotFiles.entries()) {
      const fileName = pathPosix.basename(filePath);
      const parentDir = pathPosix.dirname(filePath);

      // Ensure directory exists if in a subfolder
      if (parentDir && parentDir !== '.' && parentDir !== '/') {
        try {
          await this.structureService.mkdirp(projectId, parentDir);
        } catch (err) {
          this.logger.warn(`Could not ensure directory ${parentDir}: ${err}`);
        }
      }

      const existingNode = currentByPath.get(filePath);

      if (fileVo.type === 'doc') {
        if (existingNode && existingNode.isDoc() && existingNode.docId) {
          // Update existing doc
          await this.docstoreService.updateDoc(projectId, existingNode.docId, {
            lines: fileVo.lines || [''],
            version: 0,
          });
          restoredDocIds.push(existingNode.docId);

          if (fileVo.isRootDoc && !existingNode.isRootDoc) {
            await this.structureService.setRootDoc(projectId, existingNode.id);
          }
        } else {
          // If a file node exists where a doc should be, remove it
          if (existingNode) {
            await this.structureService.deleteNode(projectId, existingNode.id);
          }

          // Create new doc in docstore
          const createdDoc = await this.docstoreService.createDoc(projectId, {
            path: filePath,
            lines: fileVo.lines || [''],
          });
          restoredDocIds.push(createdDoc._id);

          // Create node in structure
          const newNode = await this.structureService.createNode(projectId, {
            name: fileName,
            path: filePath,
            type: 'DOC',
            docId: createdDoc._id,
            isRootDoc: fileVo.isRootDoc,
          });

          if (fileVo.isRootDoc) {
            await this.structureService.setRootDoc(projectId, newNode.id);
          }
        }
      } else if (fileVo.type === 'file' && fileVo.fileId) {
        if (!existingNode) {
          await this.structureService.createNode(projectId, {
            name: fileName,
            path: filePath,
            type: 'FILE',
            fileId: fileVo.fileId,
          });
        }
      }
    }

    return {
      restoredFilesCount: snapshotFiles.size,
      restoredDocIds,
    };
  }
}
