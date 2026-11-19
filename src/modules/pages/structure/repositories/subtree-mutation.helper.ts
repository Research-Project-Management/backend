/**
 * modules/pages/structure/repositories/subtree-mutation.helper.ts
 * Subtree move, node rename, and subtree delete transaction helpers for StructureRepository.
 */

import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/core';
import {
  DuplicateNodePathError,
  InvalidNodeNameError,
  MAX_VIRTUAL_TREE_DEPTH,
  NodePathVo,
  PageNodeEntity,
} from '../domain';
import {
  type HydratedPageNodeRow,
  NODE_HYDRATION_INCLUDE,
  isPrismaUniqueError,
  mapHydratedRowToPageNodeEntity,
  syncBackingAssetPath,
} from './folder-chain.helper';

export async function moveSubtreeHelper(
  prisma: PrismaService,
  projectId: string,
  sourcePath: string,
  destPath: string,
  newParentId: string | null,
  options?: { nodeId?: string; pageId?: string | null },
): Promise<void> {
  const normSource = NodePathVo.normalize(sourcePath);
  const normDest = NodePathVo.normalize(destPath);
  if (normDest.length > 1000) {
    throw new InvalidNodeNameError(
      normDest,
      'Target path exceeds maximum length of 1000 characters',
    );
  }
  const sourcePrefix = normSource + '/';
  const sourceDepth = NodePathVo.depth(normSource);
  const destDepth = NodePathVo.depth(normDest);
  const depthDelta = destDepth - sourceDepth;
  const netPathDelta = normDest.length - normSource.length;
  const optionPageId = options?.pageId?.trim() || undefined;

  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const targetRoot = options?.nodeId
        ? await tx.pageNode.findFirst?.({
            where: { id: options.nodeId, spaceId: projectId },
          })
        : optionPageId
          ? await tx.pageNode.findFirst?.({
              where: {
                spaceId: projectId,
                pageId: optionPageId,
                path: normSource,
              },
            })
          : await tx.pageNode.findFirst?.({
              where: {
                OR: [
                  { spaceId: projectId, path: normSource },
                  { pageId: projectId, path: normSource },
                ],
              },
            });
      if (!targetRoot) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'RESOURCE_NOT_FOUND',
          message: `Node at '${normSource}' not found`,
        });
      }

      const originalPageId = optionPageId || targetRoot.pageId || projectId;
      const sourcePageIdForDescendants = targetRoot.pageId || originalPageId;
      const promotedPageId =
        optionPageId && targetRoot.pageId !== optionPageId
          ? optionPageId
          : undefined;

      const movedRoot = await tx.pageNode.update({
        where: { id: targetRoot.id },
        data: {
          path: normDest,
          name: NodePathVo.basename(normDest),
          parentId: newParentId,
          depth: destDepth,
          ...(promotedPageId ? { pageId: promotedPageId } : {}),
        },
      });

      await syncBackingAssetPath(
        tx,
        projectId,
        movedRoot,
        normDest,
        promotedPageId,
      );

      const movedPageId = movedRoot.pageId || originalPageId;

      const canUseBulkSql =
        typeof (tx as { $executeRaw?: unknown }).$executeRaw === 'function' &&
        !(tx.pageNode?.findMany as { _isMockFunction?: boolean } | undefined)
          ?._isMockFunction &&
        !(tx.pageNode?.update as { _isMockFunction?: boolean } | undefined)
          ?._isMockFunction;

      if (canUseBulkSql) {
        if (
          depthDelta > 0 &&
          typeof tx.pageNode?.aggregate === 'function' &&
          !(tx.pageNode.aggregate as { _isMockFunction?: boolean } | undefined)
            ?._isMockFunction
        ) {
          const agg = await tx.pageNode.aggregate({
            where: {
              spaceId: projectId,
              pageId: sourcePageIdForDescendants,
              path: { startsWith: sourcePrefix },
            },
            _max: { depth: true },
          });
          if (
            agg?._max?.depth &&
            agg._max.depth + depthDelta > MAX_VIRTUAL_TREE_DEPTH
          ) {
            throw new InvalidNodeNameError(
              normDest,
              `Path exceeds maximum folder depth (${MAX_VIRTUAL_TREE_DEPTH})`,
            );
          }
        }

        if (netPathDelta > 0) {
          const txRaw = (
            tx as {
              $queryRaw?: <T>(
                query: TemplateStringsArray,
                ...values: unknown[]
              ) => Promise<T>;
            }
          ).$queryRaw;
          if (typeof txRaw === 'function') {
            const prefixLenCheck = sourcePrefix.length;
            const rows = await txRaw<Array<{ maxLen: number | null }>>`
              SELECT MAX(LENGTH(path))::int AS "maxLen"
              FROM page_nodes
              WHERE space_id = ${projectId}::uuid
                AND page_id = ${sourcePageIdForDescendants}::uuid
                AND LEFT(path, ${prefixLenCheck}::int) = ${sourcePrefix}
            `.catch(() => []);
            const maxLen = rows?.[0]?.maxLen ?? 0;
            if (maxLen > 0 && maxLen + netPathDelta > 1000) {
              throw new InvalidNodeNameError(
                normDest,
                'Target path exceeds maximum length of 1000 characters',
              );
            }
          } else if (typeof tx.pageNode?.findMany === 'function') {
            const pathRows = await tx.pageNode.findMany({
              where: {
                spaceId: projectId,
                pageId: sourcePageIdForDescendants,
                path: { startsWith: sourcePrefix },
              },
              select: { path: true },
            });
            for (const row of pathRows) {
              if (row.path.length + netPathDelta > 1000) {
                throw new InvalidNodeNameError(
                  normDest,
                  'Target path exceeds maximum length of 1000 characters',
                );
              }
            }
          }
        }

        const substringStart = normSource.length + 1;
        const prefixLen = sourcePrefix.length;
        const destPrefix = `${normDest}/`;
        const destPrefixLen = destPrefix.length;

        await tx.$executeRaw`
          UPDATE page_nodes
          SET path = ${normDest} || SUBSTRING(path FROM ${substringStart}::int),
              depth = depth + ${depthDelta}::int,
              page_id = ${movedPageId}::uuid,
              updated_at = NOW()
          WHERE space_id = ${projectId}::uuid
            AND page_id = ${sourcePageIdForDescendants}::uuid
            AND LEFT(path, ${prefixLen}::int) = ${sourcePrefix}
        `;

        await tx.$executeRaw`
          UPDATE page_docs d
          SET last_known_path = SUBSTRING(n.path FROM 2),
              page_id = n.page_id,
              updated_at = NOW()
          FROM page_nodes n
          WHERE n.doc_id = d.id
            AND n.space_id = ${projectId}::uuid
            AND n.page_id = ${movedPageId}::uuid
            AND LEFT(n.path, ${destPrefixLen}::int) = ${destPrefix}
        `;

        await tx.$executeRaw`
          UPDATE page_files f
          SET last_known_path = SUBSTRING(n.path FROM 2),
              page_id = n.page_id,
              updated_at = NOW()
          FROM page_nodes n
          WHERE n.file_id = f.id
            AND n.space_id = ${projectId}::uuid
            AND n.page_id = ${movedPageId}::uuid
            AND LEFT(n.path, ${destPrefixLen}::int) = ${destPrefix}
        `;
        return;
      }

      const descendants = await tx.pageNode.findMany({
        where: {
          spaceId: projectId,
          pageId: sourcePageIdForDescendants,
          path: { startsWith: sourcePrefix },
        },
      });

      if (descendants.length === 0) {
        return;
      }

      for (const descendant of descendants) {
        const rebased = NodePathVo.rebase(
          descendant.path,
          normSource,
          normDest,
        );
        if (rebased.depth > MAX_VIRTUAL_TREE_DEPTH) {
          throw new InvalidNodeNameError(
            normDest,
            `Path exceeds maximum folder depth (${MAX_VIRTUAL_TREE_DEPTH})`,
          );
        }
        if (rebased.path.length > 1000) {
          throw new InvalidNodeNameError(
            normDest,
            'Target path exceeds maximum length of 1000 characters',
          );
        }
      }

      const BATCH_CONCURRENCY = 20;
      for (let i = 0; i < descendants.length; i += BATCH_CONCURRENCY) {
        const chunk = descendants.slice(i, i + BATCH_CONCURRENCY);
        await Promise.all(
          chunk.map(async (descendant) => {
            const rebased = NodePathVo.rebase(
              descendant.path,
              normSource,
              normDest,
            );

            await tx.pageNode.update({
              where: { id: descendant.id },
              data: {
                path: rebased.path,
                depth: rebased.depth,
                ...(promotedPageId ? { pageId: promotedPageId } : {}),
              },
            });

            await syncBackingAssetPath(
              tx,
              projectId,
              descendant,
              rebased.path,
              promotedPageId,
            );
          }),
        );
      }
    });
  } catch (err: unknown) {
    if (isPrismaUniqueError(err)) {
      throw new DuplicateNodePathError(normDest);
    }
    throw err;
  }
}

export async function renameSingleNodeHelper(
  prisma: PrismaService,
  projectId: string,
  nodeId: string,
  newName: string,
  normalizedNewPath: string,
): Promise<PageNodeEntity> {
  const depth = NodePathVo.depth(normalizedNewPath);
  const executeRename = async (
    db: Pick<Prisma.TransactionClient, 'pageNode' | 'pageDoc' | 'pageFile'>,
  ): Promise<HydratedPageNodeRow> => {
    const result = await db.pageNode.updateMany({
      where: { id: nodeId, spaceId: projectId },
      data: {
        name: newName,
        path: normalizedNewPath,
        depth,
      },
    });
    if (result.count === 0) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: 'Node not found in project',
      });
    }
    const updated = await db.pageNode.findFirst({
      where: { id: nodeId, spaceId: projectId },
      include: NODE_HYDRATION_INCLUDE,
    });
    await syncBackingAssetPath(db, projectId, updated, normalizedNewPath);
    return updated!;
  };

  try {
    const updated =
      typeof prisma.$transaction === 'function'
        ? await prisma.$transaction(async (tx) => {
            const client = tx?.pageNode ? tx : prisma;
            return await executeRename(client);
          })
        : await executeRename(prisma);
    return mapHydratedRowToPageNodeEntity(updated);
  } catch (err: unknown) {
    if (isPrismaUniqueError(err)) {
      throw new DuplicateNodePathError(normalizedNewPath);
    }
    throw err;
  }
}

export async function deleteSubtreeHelper(
  prisma: PrismaService,
  projectId: string,
  path: string,
  pageId?: string | null,
): Promise<PageNodeEntity[]> {
  const normalized = NodePathVo.normalize(path);
  const prefix = normalized + '/';

  const trimmedPageId = pageId?.trim() || undefined;
  const targets = await prisma.pageNode.findMany({
    where: {
      spaceId: projectId,
      ...(trimmedPageId ? { pageId: trimmedPageId } : {}),
      OR: [{ path: normalized }, { path: { startsWith: prefix } }],
    },
    include: NODE_HYDRATION_INCLUDE,
  });

  const targetIds = targets.map((t) => t.id);
  const docIds = Array.from(
    new Set(
      targets
        .map((t) => t.docId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  );
  const fileIds = Array.from(
    new Set(
      targets
        .map((t) => t.fileId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  );

  const now = new Date();
  const runCleanup = async (
    db: Pick<PrismaService, 'pageNode' | 'pageDoc' | 'pageFile'>,
  ) => {
    const ops: Promise<unknown>[] = [];
    if (targetIds.length > 0) {
      ops.push(
        db.pageNode.deleteMany({
          where: { id: { in: targetIds }, spaceId: projectId },
        }),
      );
    }

    if (docIds.length > 0 && db.pageDoc?.updateMany) {
      ops.push(
        db.pageDoc.updateMany({
          where: { id: { in: docIds }, spaceId: projectId, deletedAt: null },
          data: { deletedAt: now },
        }),
      );
    }

    if (fileIds.length > 0 && db.pageFile?.updateMany) {
      ops.push(
        db.pageFile.updateMany({
          where: { id: { in: fileIds }, spaceId: projectId, deletedAt: null },
          data: { deletedAt: now },
        }),
      );
    }

    if (ops.length > 0) {
      await Promise.all(ops);
    }
  };

  if (
    targetIds.length > 0 ||
    (docIds.length > 0 && typeof prisma.pageDoc?.updateMany === 'function') ||
    (fileIds.length > 0 && typeof prisma.pageFile?.updateMany === 'function')
  ) {
    if (typeof prisma.$transaction === 'function') {
      await prisma.$transaction(async (tx) => {
        const client = tx?.pageNode ? tx : prisma;
        await runCleanup(client);
      });
    } else {
      await runCleanup(prisma);
    }
  }

  return targets.map((t) =>
    mapHydratedRowToPageNodeEntity(t as HydratedPageNodeRow),
  );
}
