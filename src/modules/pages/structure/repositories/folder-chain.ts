/**
 * modules/pages/structure/repositories/folder-chain.ts
 * Folder chain materialization, hydration, and entity mapping helpers for StructureRepository.
 */

import { PageNode, Prisma } from '@prisma/client';
import {
  ensureCanonicalPageId,
  type PageScopeDbClient,
} from '@/modules/pages/core/utils/page-scope';
import { PageNodeEntity } from '@/modules/pages/structure/domain/node.entity';
import { NodePathVo, ParsedFolderSegment } from '@/modules/pages/core/utils/node-path';
import { StructureError } from '@/modules/pages/structure/domain/structure.errors';

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

import {
  isPrismaUniqueError,
  ensurePrismaFolderChain,
} from '@/modules/pages/core/utils/folder-chain';
export { isPrismaUniqueError, ensurePrismaFolderChain };

export async function ensureFolderChainInTxHelper(
  tx: Prisma.TransactionClient,
  projectId: string,
  folderPathOrChain: string | readonly ParsedFolderSegment[],
  pageId?: string | null,
): Promise<string | null> {
  if (typeof folderPathOrChain === 'string') {
    const normalized = NodePathVo.normalize(folderPathOrChain);
    if (normalized === '/') return null;
    const segments = normalized.slice(1).split('/');
    const chain: ParsedFolderSegment[] = [];
    let currentPath = '';
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      NodePathVo.validateFilename(seg);
      currentPath = `${currentPath}/${seg}`;
      chain.push({
        name: seg,
        path: currentPath,
        depth: i + 1,
      });
    }
    return await ensurePrismaFolderChain(tx, projectId, chain, pageId);
  }
  return await ensurePrismaFolderChain(
    tx,
    projectId,
    folderPathOrChain,
    pageId,
  );
}

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
