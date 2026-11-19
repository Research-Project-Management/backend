import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccessRepository } from '../access.repository';
import {
  extractRagDocIdFromMetadata,
  hasDirectFileOwnership,
} from '../domain/access.policy';
import type { ResolvedPaperTarget } from '../types/access.type';
import { SpaceAccessService } from './space.service';

@Injectable()
export class DocumentAccessService {
  constructor(
    private readonly repo: AccessRepository,
    private readonly spaceAccess: SpaceAccessService,
  ) {}

  async resolveVectorDocumentIds(documentIds: string[]): Promise<string[]> {
    if (!documentIds.length) return [];

    const docMap = new Map<string, string>();
    const files = await this.repo.findStorageFilesMetadata(documentIds);
    for (const file of files) {
      const ragDocId = extractRagDocIdFromMetadata(file.metadata);
      if (ragDocId) {
        docMap.set(file.id, ragDocId);
      }
    }

    const unresolvedIds = documentIds.filter((id) => !docMap.has(id));
    if (unresolvedIds.length > 0) {
      const items =
        await this.repo.findLibraryItemsWithAttachments(unresolvedIds);
      for (const item of items) {
        const itemRagId = extractRagDocIdFromMetadata(item.metadata);
        if (itemRagId) {
          docMap.set(item.id, itemRagId);
          continue;
        }
        const attachments = item.attachments || [];
        if (attachments.length === 0) continue;

        const primary =
          attachments.find((att) => att.attachmentType === 'primary_pdf') ||
          attachments[0];
        const attRagId = extractRagDocIdFromMetadata(primary.metadata);
        if (attRagId) {
          docMap.set(item.id, attRagId);
        } else if (primary.fileId) {
          const fileMeta = await this.repo.findStorageFileMetadata(
            primary.fileId,
          );
          const fileRagId = extractRagDocIdFromMetadata(fileMeta);
          if (fileRagId) {
            docMap.set(item.id, fileRagId);
          }
        }
      }
    }

    return documentIds.map((id) => docMap.get(id) || id);
  }

  async resolvePaperTarget(
    userId: string,
    paperOrFileId: string,
  ): Promise<ResolvedPaperTarget> {
    const item = await this.repo.findLibraryItemDetail(paperOrFileId);
    if (item) {
      const canAccess =
        item.createdById === userId ||
        (await this.spaceAccess.hasSpaceOrProjectAccess(userId, item.spaceId));

      if (!canAccess) {
        throw new ForbiddenException('You do not have access to this paper');
      }

      let ragDocId = extractRagDocIdFromMetadata(item.metadata);

      if (!ragDocId && item.attachments && item.attachments.length > 0) {
        const primaryAtt =
          item.attachments.find(
            (att) => att.attachmentType === 'primary_pdf',
          ) || item.attachments[0];
        ragDocId = extractRagDocIdFromMetadata(primaryAtt.metadata);
        if (!ragDocId && primaryAtt.fileId) {
          const fileMeta = await this.repo.findStorageFileMetadata(
            primaryAtt.fileId,
          );
          ragDocId = extractRagDocIdFromMetadata(fileMeta);
        }
      }

      return {
        title: item.title,
        authors: item.contributors?.map((c) => c.fullName) || [],
        year: item.year ?? undefined,
        doi: item.doi ?? undefined,
        abstract: item.abstract ?? undefined,
        ragDocId,
        spaceId: item.spaceId || userId,
      };
    }

    const file = await this.repo.findStorageFileDetail(paperOrFileId, userId);
    if (file) {
      let canAccess = hasDirectFileOwnership(file, userId);
      if (!canAccess && file.spaceId) {
        canAccess = await this.spaceAccess.hasSpaceOrProjectAccess(
          userId,
          file.spaceId,
        );
      }
      if (
        !canAccess &&
        file.linkedToType?.toLowerCase() === 'project' &&
        file.linkedToId
      ) {
        canAccess = await this.spaceAccess.hasSpaceOrProjectAccess(
          userId,
          file.linkedToId,
        );
      }

      if (!canAccess) {
        throw new ForbiddenException('You do not have access to this file');
      }

      const meta =
        file.metadata && typeof file.metadata === 'object'
          ? (file.metadata as {
              title?: unknown;
              authors?: unknown;
              year?: unknown;
              doi?: unknown;
              abstract?: unknown;
              ragDocId?: unknown;
            })
          : {};

      const spaceId =
        file.spaceId ||
        (file.linkedToType?.toLowerCase() === 'project' && file.linkedToId
          ? file.linkedToId
          : userId);

      const authors = Array.isArray(meta.authors)
        ? meta.authors.filter((a): a is string => typeof a === 'string')
        : typeof meta.authors === 'string'
          ? [meta.authors]
          : [];

      return {
        title: typeof meta.title === 'string' ? meta.title : file.filename,
        authors,
        year:
          typeof meta.year === 'number' || typeof meta.year === 'string'
            ? meta.year
            : undefined,
        doi: typeof meta.doi === 'string' ? meta.doi : undefined,
        abstract: typeof meta.abstract === 'string' ? meta.abstract : undefined,
        ragDocId: typeof meta.ragDocId === 'string' ? meta.ragDocId : null,
        spaceId,
      };
    }

    const parentItemId =
      await this.repo.findAttachmentParentItemId(paperOrFileId);
    if (parentItemId) {
      return this.resolvePaperTarget(userId, parentItemId);
    }

    throw new NotFoundException(
      `Paper or scientific file with ID ${paperOrFileId} not found`,
    );
  }
}
