/**
 * modules/pages/core/utils/folder-chain.ts
 * Shared Prisma PageNode folder-chain materializer (mkdir -p) for docstore, filestore, and structure.
 */

import {
  ensureCanonicalPageId,
  type PageScopeDbClient,
} from './page-scope';
import { NodePathVo, type ParsedFolderSegment } from './node-path';
import { StructureError } from '../domain/errors';

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
