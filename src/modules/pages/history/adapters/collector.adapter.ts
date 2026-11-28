/**
 * history/adapters/collector.adapter.ts
 * Driven Cross-Context Adapter collecting current page trees and streaming snapshot ZIPs.
 */

import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { Readable } from 'node:stream';
import { mapWithConcurrency } from '@/core';
import { FILES_PORT } from '@/modules/files/files.constant';
import { type IFilesPort } from '@/modules/files/types/files.type';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
  createZipStream,
  type ZipEntry,
} from '@/modules/pages/core';
import { DocstoreService } from '@/modules/pages/docstore';
import {
  FilestoreService,
  IBinaryStoragePort,
} from '@/modules/pages/filestore';
import {
  StructureService,
  type PageNodeEntity,
} from '@/modules/pages/structure';
import { Snapshot, FileSnapshotVo } from '../domain/snapshot';

const COLLECT_CONCURRENCY = 6;
const DEFAULT_MANUSCRIPT_BUCKET = 'manuscript-files';

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

@Injectable()
export class SnapshotCollectorAdapter {
  private readonly logger = new Logger(SnapshotCollectorAdapter.name);
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    private readonly structureService: StructureService,
    private readonly docstoreService: DocstoreService,
    private readonly filestoreService: FilestoreService,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollab?: LiveCollaborationPort,
    @Optional()
    @Inject(IBinaryStoragePort)
    private readonly binaryStorage?: IBinaryStoragePort,
    @Optional()
    @Inject(FILES_PORT)
    private readonly filesPort?: IFilesPort,
  ) {
    this.liveCollab = liveCollab ?? NOOP_LIVE_COLLABORATION;
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
    await this.liveCollab.flushDocs(projectId, docIds).catch(() => []);

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
              ? typeof fileMeta.hash.getValue === 'function'
                ? fileMeta.hash.getValue()
                : String(fileMeta.hash)
              : node.hash || '';
            const storageKey = fileMeta.storageKey
              ? typeof fileMeta.storageKey.getValue === 'function'
                ? fileMeta.storageKey.getValue()
                : String(fileMeta.storageKey)
              : null;
            return FileSnapshotVo.createFile(
              node.path,
              node.fileId,
              hashString,
              fileMeta.sizeBytes || node.sizeBytes || 0,
              storageKey,
              fileMeta.blobId ?? null,
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
      } else if (
        fileVo.type === 'file' &&
        (fileVo.storageKey || fileVo.fileId)
      ) {
        const pinnedStorageKey = fileVo.storageKey?.trim() || null;
        const fileId = fileVo.fileId ?? null;
        entries.push({
          path: relPath,
          date: snapshot.createdAt,
          getData: async () => {
            try {
              if (pinnedStorageKey) {
                if (this.binaryStorage) {
                  const stream = await this.binaryStorage.getObjectStream(
                    DEFAULT_MANUSCRIPT_BUCKET,
                    pinnedStorageKey,
                  );
                  return await streamToBuffer(stream);
                }
                if (typeof this.filesPort?.getObjectStream === 'function') {
                  const obj = await this.filesPort.getObjectStream(
                    pinnedStorageKey,
                  );
                  return await streamToBuffer(obj.stream);
                }
              }

              if (fileId) {
                const streamResult = await this.filestoreService.openReadStream(
                  projectId,
                  fileId,
                );
                return await streamToBuffer(streamResult.stream);
              }
              return null;
            } catch (err) {
              this.logger.warn(
                `Failed to read historical file ${pinnedStorageKey ?? fileId ?? ''} (${relPath}) for snapshot ZIP: ${err}`,
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
