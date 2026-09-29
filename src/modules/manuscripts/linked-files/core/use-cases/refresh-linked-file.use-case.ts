/**
 * linked-files/core/use-cases/refresh-linked-file.use-case.ts
 * Inbound Use Case: Re-downloads or re-synchronizes an existing linked file on-demand or via background worker.
 */

import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ILinkedFilesRepositoryPort } from '../ports/linked-files-repository.port';
import { LinkedFileEntity } from '../domain/entities/linked-file.entity';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { FilestoreService } from '@/modules/manuscripts/filestore/filestore.service';
import { CitationsService } from '@/modules/manuscripts/citations/citations.service';
import { RealtimeService } from '@/modules/realtime/realtime.service';
import { LineArrayEngine } from '@/modules/manuscripts/docstore/core/adapters/engine/line-array.engine';
import { assertSafeExternalUrl } from '../utils/ssrf-guard.util';

@Injectable()
export class RefreshLinkedFileUseCase {
  private readonly logger = new Logger(RefreshLinkedFileUseCase.name);

  constructor(
    private readonly repository: ILinkedFilesRepositoryPort,
    private readonly structureService: StructureService,
    private readonly docstoreService: DocstoreService,
    private readonly filestoreService: FilestoreService,
    private readonly citationsService: CitationsService,
    private readonly realtimeService?: RealtimeService,
  ) {}

  public async execute(
    projectId: string,
    fileIdOrLinkedFileId: string,
    userId?: string,
  ): Promise<LinkedFileEntity> {
    // Lookup by linked file id or by node fileId
    let linkedFile = await this.repository.findById(
      projectId,
      fileIdOrLinkedFileId,
    );
    if (!linkedFile) {
      linkedFile = await this.repository.findByNodeId(
        projectId,
        fileIdOrLinkedFileId,
      );
    }

    if (!linkedFile) {
      throw new NotFoundException(
        `Linked file "${fileIdOrLinkedFileId}" not found in project "${projectId}"`,
      );
    }

    try {
      if (linkedFile.provider === 'url' && linkedFile.url) {
        const validatedUrl = await assertSafeExternalUrl(linkedFile.url);
        const response = await fetch(validatedUrl.toString(), {
          signal: AbortSignal.timeout(30000),
          headers: { 'User-Agent': 'Flux-Manuscript-LinkedFiles/1.0' },
        });

        if (!response.ok) {
          throw new Error(
            `Remote server returned HTTP ${response.status} ${response.statusText}`,
          );
        }

        const arrayBuf = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);
        const mimeType =
          response.headers.get('content-type') || 'application/octet-stream';

        if (linkedFile.docId) {
          // Update text in docstore
          const textContent = buffer.toString('utf8');
          const lines = LineArrayEngine.textToLines(textContent);
          const currentDoc = await this.docstoreService
            .getDoc(projectId, linkedFile.docId)
            .catch(() => null);
          const nextVersion = (currentDoc?.version ?? 0) + 1;
          await this.docstoreService.updateDoc(projectId, linkedFile.docId, {
            lines,
            version: nextVersion,
          });

          this.realtimeService?.broadcastEvent(
            projectId,
            'doc:content-updated',
            {
              docId: linkedFile.docId,
            },
          );
        } else if (linkedFile.fileId) {
          // Re-upload binary asset
          const newFile = await this.filestoreService.uploadFileFromBuffer(
            projectId,
            linkedFile.name,
            buffer,
            mimeType,
          );
          linkedFile.fileId = newFile.id;
        }
      } else if (
        (linkedFile.provider === 'zotero' ||
          linkedFile.provider === 'mendeley') &&
        linkedFile.collectionId
      ) {
        await this.citationsService.syncLibraryCollection(
          projectId,
          userId || 'anonymous',
          {
            collectionId: linkedFile.collectionId,
            targetFilename: linkedFile.name,
          },
        );

        if (linkedFile.docId) {
          this.realtimeService?.broadcastEvent(
            projectId,
            'doc:content-updated',
            {
              docId: linkedFile.docId,
            },
          );
        }
      }

      linkedFile.markSynced(
        linkedFile.nodeId ?? undefined,
        linkedFile.docId ?? undefined,
        linkedFile.fileId ?? undefined,
      );
      await this.repository.save(linkedFile);

      this.realtimeService?.broadcastFileTreeChange(projectId, {
        action: 'linked-file-refreshed',
        node: {
          id: linkedFile.nodeId,
          name: linkedFile.name,
          linkedFileId: linkedFile.id,
        },
      });

      return linkedFile;
    } catch (err: any) {
      linkedFile.markFailed(err?.message || 'Refresh failed');
      await this.repository.save(linkedFile);
      this.logger.warn(
        `Failed to refresh linked file ${linkedFile.id}: ${err?.message}`,
      );
      throw new BadRequestException(`Refresh failed: ${err?.message}`);
    }
  }
}
