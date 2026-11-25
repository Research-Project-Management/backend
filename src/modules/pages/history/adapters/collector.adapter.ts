/**
 * history/adapters/collector.adapter.ts
 * Driven Cross-Context Adapter collecting current page trees and streaming snapshot ZIPs.
 */

import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { Readable } from 'node:stream';
import { mapWithConcurrency } from '@/core';
import {
  LiveCollaborationPort,
  LIVE_COLLABORATION_PORT,
  NOOP_LIVE_COLLABORATION,
  createZipStream,
  type ZipEntry,
} from '@/modules/pages/core';
import { StructureService } from '@/modules/pages/structure/structure.service';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { FilestoreService } from '@/modules/pages/filestore/filestore.service';
import type { PageNodeEntity } from '@/modules/pages/structure/domain';
import { ISnapshotCollectorPort } from '../domain/ports';
import { Snapshot } from '../domain/snapshot.entity';
import { FileSnapshotVo } from '../domain/file-snapshot.vo';

const COLLECT_CONCURRENCY = 6;

@Injectable()
export class SnapshotCollectorAdapter extends ISnapshotCollectorPort {
  private readonly logger = new Logger(SnapshotCollectorAdapter.name);
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    private readonly structureService: StructureService,
    private readonly docstoreService: DocstoreService,
    private readonly filestoreService: FilestoreService,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollab?: LiveCollaborationPort,
  ) {
    super();
    this.liveCollab = liveCollab ?? NOOP_LIVE_COLLABORATION;
  }

  private getLiveCollab(): LiveCollaborationPort {
    return this.liveCollab;
  }

  public async collectCurrentState(
    projectId: string,
    pageId?: string,
  ): Promise<Map<string, FileSnapshotVo>> {
    const nodes = await this.structureService.getAllNodes(
      projectId,
      undefined,
      pageId,
    );

    const docIds = nodes.filter((n) => n.docId).map((n) => n.docId as string);
    await this.getLiveCollab()
      .flushDocs(projectId, docIds)
      .catch(() => []);

    const filesMap = new Map<string, FileSnapshotVo>();

    const collected = await mapWithConcurrency<
      PageNodeEntity,
      FileSnapshotVo | null
    >(
      nodes.filter((n) => !n.isFolder()),
      COLLECT_CONCURRENCY,
      async (node: PageNodeEntity): Promise<FileSnapshotVo | null> => {
        if (node.isDoc() && node.docId) {
          try {
            const doc = await this.docstoreService.getDoc(
              projectId,
              node.docId,
            );
            return FileSnapshotVo.createDoc(
              node.path,
              node.docId,
              doc.lines || [''],
              doc.hash || '',
              node.isRootDoc,
            );
          } catch (error) {
            this.logger.error(
              `Error collecting doc ${node.docId} at path ${node.path}: ${error}`,
            );
          }
        } else if (node.type === 'FILE' && node.fileId) {
          try {
            const fileMeta = await this.filestoreService.getFileMetadata(
              projectId,
              node.fileId,
            );
            const hashString = fileMeta.hash
              ? fileMeta.hash.getValue()
              : node.hash || '';
            return FileSnapshotVo.createFile(
              node.path,
              node.fileId,
              hashString,
              fileMeta.sizeBytes || node.sizeBytes || 0,
            );
          } catch (error) {
            this.logger.error(
              `Error collecting file ${node.fileId} at path ${node.path}: ${error}`,
            );
          }
        }
        return null;
      },
    );
    for (const vo of collected) {
      if (vo) filesMap.set(vo.path, vo);
    }

    return filesMap;
  }

  public createSnapshotZipStream(
    projectId: string,
    snapshot: Snapshot,
  ): { zipStream: Readable; fileCount: number } {
    const entries: ZipEntry[] = [];
    const snapshotFiles = snapshot.files;

    for (const [filePath, fileVo] of snapshotFiles.entries()) {
      const relPath = filePath.replace(/^\/+/, '');
      if (!relPath) continue;

      if (fileVo.type === 'doc') {
        const textContent = (fileVo.lines || ['']).join('\n');
        entries.push({
          path: relPath,
          data: Buffer.from(textContent, 'utf8'),
          date: snapshot.createdAt,
        });
      } else if (fileVo.type === 'file' && fileVo.fileId) {
        const fileId = fileVo.fileId;
        entries.push({
          path: relPath,
          date: snapshot.createdAt,
          getData: async () => {
            try {
              const streamResult = await this.filestoreService.openReadStream(
                projectId,
                fileId,
              );
              const chunks: Buffer[] = [];
              for await (const chunk of streamResult.stream) {
                chunks.push(
                  Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
                );
              }
              return Buffer.concat(chunks);
            } catch (err) {
              this.logger.warn(
                `Failed to read historical file ${fileId} (${relPath}) for snapshot ZIP: ${err}`,
              );
              return null;
            }
          },
        });
      }
    }

    if (entries.length === 0) {
      entries.push({
        path: 'main.tex',
        data: Buffer.from(
          '\\documentclass{article}\n\\begin{document}\n\\end{document}',
          'utf8',
        ),
        date: snapshot.createdAt,
      });
    }

    return {
      zipStream: createZipStream(entries),
      fileCount: entries.length,
    };
  }
}
