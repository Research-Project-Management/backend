/**
 * modules/pages/structure/repositories/folder-chain.helper.ts
 * Folder chain materialization, hydration, and entity mapping helpers for StructureRepository.
 */

import { PageNode, Prisma } from '@prisma/client';
import {
  ensureCanonicalPageId,
  type PageScopeDbClient,
} from '@/modules/pages/core/page-scope.helper';
import {
  PageNodeEntity,
  NodePathVo,
  ParsedFolderSegment,
  StructureError,
} from '../domain';

export const NODE_HYDRATION_INCLUDE = {
  doc: { select: { sizeBytes: true, hash: true, rev: true } },
  file: { select: { sizeBytes: true, hash: true, blobId: true } },
  page: { select: { rootDocId: true } },
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
  page?: { rootDocId?: string | null } | null;
  isRootDoc?: boolean | null;
  sizeBytes?: number | null;
  hash?: string | null;
  rev?: number | null;
};

export function isPrismaUniqueError(err: unknown): boolean {
  const errObj = err as { code?: string; message?: string } | null;
  return Boolean(
    errObj?.code === 'P2002' || errObj?.message?.includes('P2002'),
  );
}

/**
 * Shared Prisma folder-chain materializer (`mkdir -p` for `PageNode` folders).
 * Safe to invoke on both `PrismaService` and transaction clients (`tx`), and preserves
 * optional-chaining (`findUnique?.`) for lightweight unit test mocks.
 */
export async function ensurePrismaFolderChain(
  db:
    | (PageScopeDbClient & {
        pageNode?: {
          findMany?(
            args: any,
          ): PromiseLike<
            Array<{ id?: string; type?: string; path?: string | null }>
          >;

          findUnique?(
            args: any,
          ): PromiseLike<{ id?: string; type?: string } | null>;

          findFirst?(
            args: any,
          ): PromiseLike<{ id?: string; type?: string } | null>;

          create?(args: any): PromiseLike<{ id?: string; type?: string }>;
        };
      })
    | null
    | undefined,
  projectId: string,
  folderChain: readonly ParsedFolderSegment[],
  pageId?: string | null,
): Promise<string | null> {
  if (!db?.pageNode || folderChain.length === 0) {
    return null;
  }

  const effectivePageId = await ensureCanonicalPageId(db, projectId, pageId);

  let preFetchedByPath: Map<
    string,
    { id?: string; type?: string } | null
  > | null = null;
  if (folderChain.length > 1 && typeof db.pageNode.findMany === 'function') {
    try {
      const existingNodes = await db.pageNode.findMany({
        where: {
          spaceId: projectId,
          pageId: effectivePageId,
          path: { in: folderChain.map((f) => f.path) },
        },
      });
      if (Array.isArray(existingNodes)) {
        preFetchedByPath = new Map(
          existingNodes
            .filter((n): n is NonNullable<typeof n> & { path: string } =>
              Boolean(n && n.path),
            )
            .map((n) => [n.path, n]),
        );
      }
    } catch {
      preFetchedByPath = null;
    }
  }

  let parentId: string | null = null;
  for (const folder of folderChain) {
    let folderNode =
      preFetchedByPath?.get(folder.path) ??
      (await db.pageNode.findUnique?.({
        where: {
          pageId_path: {
            pageId: effectivePageId,
            path: folder.path,
          },
        },
      })) ??
      (await db.pageNode.findFirst?.({
        where: {
          spaceId: projectId,
          pageId: effectivePageId,
          path: folder.path,
        },
      }));
    if (!folderNode && db.pageNode.create) {
      try {
        folderNode = await db.pageNode.create({
          data: {
            spaceId: projectId,
            pageId: effectivePageId,
            parentId,
            type: 'FOLDER',
            name: folder.name,
            path: folder.path,
            depth: folder.depth,
            sortOrder: 0,
          },
        });
      } catch (createErr: unknown) {
        if (isPrismaUniqueError(createErr)) {
          folderNode =
            (await db.pageNode.findUnique?.({
              where: {
                pageId_path: {
                  pageId: effectivePageId,
                  path: folder.path,
                },
              },
            })) ??
            (await db.pageNode.findFirst?.({
              where: {
                spaceId: projectId,
                pageId: effectivePageId,
                path: folder.path,
              },
            })) ??
            null;
        } else {
          throw createErr;
        }
      }
    }
    if (folderNode && folderNode.type && folderNode.type !== 'FOLDER') {
      throw new StructureError(
        `Parent node at '${folder.path}' must be a FOLDER (found ${folderNode.type})`,
      );
    }
    parentId = folderNode?.id ?? parentId;
  }
  return parentId;
}

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
