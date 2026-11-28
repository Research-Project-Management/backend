/**
 * modules/pages/structure/repositories/folder-chain.ts
 * Hydration include contract, backing asset path sync, and entity mapping helpers for StructureRepository.
 */

import { PageNode, Prisma } from '@prisma/client';
import {
  NodePathVo,
  ensurePrismaFolderChain,
  isPrismaUniqueError,
} from '@/modules/pages/core';
import { PageNodeEntity } from '../domain/node.entity';

export { isPrismaUniqueError, ensurePrismaFolderChain };

export const NODE_HYDRATION_INCLUDE = {
  doc: { select: { sizeBytes: true, hash: true, rev: true } },
  file: { select: { sizeBytes: true, hash: true, blobId: true } },
  page: { select: { rootDocId: true, deletedAt: true } },
} as const;

export type HydratedPageNodeRow = PageNode & {
  doc?: {
    sizeBytes?: number | null;
    hash?: string | null;
    rev?: number | null;
  } | null;
  file?: {
    sizeBytes?: number | null;
    hash?: string | null;
    blobId?: string | null;
  } | null;
  page?: { rootDocId?: string | null; deletedAt?: Date | null } | null;
  isRootDoc?: boolean | null;
  sizeBytes?: number | null;
  hash?: string | null;
  rev?: number | null;
};

export async function syncBackingAssetPath(
  db: Pick<Prisma.TransactionClient, 'pageDoc' | 'pageFile'>,
  projectId: string,
  node: { docId?: string | null; fileId?: string | null } | null | undefined,
  virtualPath: string,
  promotedPageId?: string | null,
): Promise<void> {
  if (!node) return;
  const relativePath = NodePathVo.toRelative(virtualPath);
  if (node.docId) {
    await db.pageDoc?.updateMany({
      where: { id: node.docId, spaceId: projectId },
      data: {
        lastKnownPath: relativePath,
        ...(promotedPageId ? { pageId: promotedPageId } : {}),
      },
    });
  }
  if (node.fileId) {
    await db.pageFile?.updateMany({
      where: { id: node.fileId, spaceId: projectId },
      data: {
        lastKnownPath: relativePath,
        ...(promotedPageId ? { pageId: promotedPageId } : {}),
      },
    });
  }
}

export function mapHydratedRowToPageNodeEntity(
  raw: HydratedPageNodeRow,
  override?: {
    isRootDoc?: boolean;
    sizeBytes?: number;
    hash?: string | null;
    rev?: number | null;
  },
): PageNodeEntity {
  const projectId =
    raw.spaceId ?? (raw as { projectId?: string }).projectId ?? '';
  const pageRootDocId = raw.page?.rootDocId;
  const isRootDoc =
    raw.type === 'DOC' &&
    Boolean(
      pageRootDocId !== undefined
        ? raw.docId && raw.docId === pageRootDocId
        : (override?.isRootDoc ?? raw.isRootDoc),
    );
  const sizeBytes =
    raw.type === 'FOLDER'
      ? 0
      : Number(
          raw.doc?.sizeBytes ??
            raw.file?.sizeBytes ??
            override?.sizeBytes ??
            raw.sizeBytes ??
            0,
        );
  const hash =
    raw.type === 'FOLDER'
      ? null
      : (raw.doc?.hash ?? raw.file?.hash ?? override?.hash ?? raw.hash ?? null);
  const rev =
    raw.type === 'DOC'
      ? (raw.doc?.rev ?? override?.rev ?? raw.rev ?? null)
      : null;

  return new PageNodeEntity({
    id: raw.id,
    projectId,
    spaceId: projectId,
    pageId: raw.pageId ?? projectId,
    parentId: raw.parentId,
    type: raw.type,
    name: raw.name,
    path: raw.path,
    depth: raw.depth,
    docId: raw.docId,
    fileId: raw.fileId,
    blobId: raw.file?.blobId ?? null,
    isRootDoc,
    sizeBytes,
    hash,
    rev,
    sortOrder: raw.sortOrder,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  });
}
