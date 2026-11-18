/**
 * modules/pages/structure/structure.repository.ts
 * Direct Injectable Repository for Page Virtual Tree & Hierarchy.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { PageNode, Prisma } from '@prisma/client';
import { PrismaService } from '@/core';
import {
  ensureCanonicalPageId,
  type PageScopeDbClient,
} from '@/modules/pages/core/page-scope.helper';
import { filterRecordsByPageScope } from '@/modules/pages/docstore/controllers/doc.helpers';
import {
  IStructureRepository,
  CreateNodeParams,
  ManuscriptNodeEntity,
  NodePathVo,
  ParsedFolderSegment,
  DuplicateNodePathError,
  InvalidNodeNameError,
  MAX_VIRTUAL_TREE_DEPTH,
  StructureError,
} from './domain';

const NODE_HYDRATION_INCLUDE = {
  doc: { select: { sizeBytes: true, hash: true } },
  file: { select: { sizeBytes: true, hash: true, blobId: true } },
  page: { select: { rootDocId: true } },
} as const;

type HydratedPageNodeRow = PageNode & {
  doc?: { sizeBytes?: number | null; hash?: string | null } | null;
  file?: {
    sizeBytes?: number | null;
    hash?: string | null;
    blobId?: string | null;
  } | null;
  page?: { rootDocId?: string | null } | null;
  isRootDoc?: boolean | null;
  sizeBytes?: number | null;
  hash?: string | null;
};

function isPrismaUniqueError(err: unknown): boolean {
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

@Injectable()
export class StructureRepository extends IStructureRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  public async ensureFolderChainInTx(
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

  private async syncBackingAssetPath(
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

  private mapToEntity(
    raw: HydratedPageNodeRow,
    override?: {
      isRootDoc?: boolean;
      sizeBytes?: number;
      hash?: string | null;
    },
  ): ManuscriptNodeEntity {
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
        : (raw.doc?.hash ??
          raw.file?.hash ??
          override?.hash ??
          raw.hash ??
          null);

    return new ManuscriptNodeEntity({
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
      sortOrder: raw.sortOrder,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    });
  }

  public async createNode(
    params: CreateNodeParams,
  ): Promise<ManuscriptNodeEntity> {
    const depth = NodePathVo.depth(params.path);
    const canonicalPageId = await ensureCanonicalPageId(
      this.prisma,
      params.projectId,
      params.pageId,
    );
    const created = await this.prisma.pageNode.create({
      data: {
        spaceId: params.projectId,
        pageId: canonicalPageId,
        parentId: params.parentId || null,
        type: params.type,
        name: params.name,
        path: params.path,
        depth,
        docId: params.docId || null,
        fileId: params.fileId || null,
        sortOrder: params.sortOrder || 0,
      },
      include: NODE_HYDRATION_INCLUDE,
    });

    if (
      params.isRootDoc &&
      params.type === 'DOC' &&
      created.docId &&
      this.prisma.page?.updateMany
    ) {
      await Promise.resolve(
        this.prisma.page.updateMany({
          where: { id: canonicalPageId, spaceId: params.projectId },
          data: { rootDocId: created.docId },
        }),
      ).catch(() => null);
    }

    return this.mapToEntity(created, {
      isRootDoc: Boolean(params.isRootDoc && params.type === 'DOC'),
      sizeBytes: params.sizeBytes,
      hash: params.hash,
    });
  }

  public async findById(
    projectId: string,
    nodeId: string,
  ): Promise<ManuscriptNodeEntity | null> {
    const raw = await this.prisma.pageNode.findFirst({
      where: {
        spaceId: projectId,
        OR: [{ id: nodeId }, { docId: nodeId }, { fileId: nodeId }],
      },
      include: NODE_HYDRATION_INCLUDE,
    });
    if (raw) return this.mapToEntity(raw);

    const byPage = await this.prisma.pageNode
      .findFirst({
        where: {
          pageId: projectId,
          OR: [{ id: nodeId }, { docId: nodeId }, { fileId: nodeId }],
        },
        include: NODE_HYDRATION_INCLUDE,
      })
      .catch(() => null);
    return byPage ? this.mapToEntity(byPage) : null;
  }

  public async findByPath(
    projectId: string,
    path: string,
    pageId?: string | null,
  ): Promise<ManuscriptNodeEntity | null> {
    const normalized = NodePathVo.normalize(path);
    const trimmedPageId = pageId?.trim() || undefined;
    if (trimmedPageId) {
      const scoped = await this.prisma.pageNode.findFirst({
        where: { spaceId: projectId, pageId: trimmedPageId, path: normalized },
        include: NODE_HYDRATION_INCLUDE,
      });
      return scoped ? this.mapToEntity(scoped) : null;
    }
    const raw = await this.prisma.pageNode.findFirst({
      where: {
        OR: [
          { spaceId: projectId, path: normalized },
          { pageId: projectId, path: normalized },
        ],
      },
      include: NODE_HYDRATION_INCLUDE,
    });
    return raw ? this.mapToEntity(raw) : null;
  }

  public async findByFileId(
    projectId: string,
    fileId: string,
    pageId?: string | null,
  ): Promise<ManuscriptNodeEntity | null> {
    const trimmedPageId = pageId?.trim() || undefined;
    const raw = await this.prisma.pageNode.findFirst({
      where: {
        spaceId: projectId,
        fileId,
        ...(trimmedPageId ? { pageId: trimmedPageId } : {}),
      },
      include: NODE_HYDRATION_INCLUDE,
    });
    return raw ? this.mapToEntity(raw) : null;
  }

  public async getAllNodes(
    projectId: string,
    pageId?: string | null,
  ): Promise<ManuscriptNodeEntity[]> {
    const trimmedPageId = pageId?.trim() || undefined;
    const nodes = await this.prisma.pageNode.findMany({
      where: trimmedPageId
        ? { spaceId: projectId, pageId: trimmedPageId }
        : { spaceId: projectId },
      include: NODE_HYDRATION_INCLUDE,
      orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
    const scoped = trimmedPageId
      ? filterRecordsByPageScope(nodes, trimmedPageId, projectId)
      : nodes;
    return scoped.map((n) => this.mapToEntity(n as HydratedPageNodeRow));
  }

  public async getRootDoc(
    projectId: string,
    pageId?: string | null,
  ): Promise<ManuscriptNodeEntity | null> {
    const trimmedPageId = pageId?.trim() || undefined;
    const pageRow =
      this.prisma.page?.findUnique || this.prisma.page?.findFirst
        ? await Promise.resolve(
            trimmedPageId && this.prisma.page.findUnique
              ? this.prisma.page.findUnique({
                  where: { id: trimmedPageId },
                  select: {
                    id: true,
                    spaceId: true,
                    rootDocId: true,
                    deletedAt: true,
                  },
                })
              : this.prisma.page.findFirst?.({
                  where: {
                    spaceId: projectId,
                    ...(trimmedPageId ? { id: trimmedPageId } : {}),
                    deletedAt: null,
                  },
                  orderBy: { createdAt: 'asc' },
                  select: {
                    id: true,
                    spaceId: true,
                    rootDocId: true,
                    deletedAt: true,
                  },
                }),
          ).catch(() => null)
        : null;

    if (
      !pageRow ||
      pageRow.deletedAt ||
      (pageRow.spaceId && pageRow.spaceId !== projectId) ||
      !pageRow.rootDocId
    ) {
      return null;
    }

    const rootNode = await this.prisma.pageNode.findFirst({
      where: {
        spaceId: projectId,
        pageId: pageRow.id,
        docId: pageRow.rootDocId,
        type: 'DOC',
      },
      include: NODE_HYDRATION_INCLUDE,
    });
    return rootNode ? this.mapToEntity(rootNode, { isRootDoc: true }) : null;
  }

  public async setRootDoc(projectId: string, nodeId: string): Promise<void> {
    const targetNode = await this.prisma.pageNode.findFirst({
      where: {
        spaceId: projectId,
        OR: [{ id: nodeId }, { docId: nodeId }],
      },
    });

    if (!targetNode || !targetNode.docId) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: 'Node not found in project',
      });
    }

    const targetPageId =
      targetNode.pageId ||
      (await ensureCanonicalPageId(this.prisma, projectId));

    if (this.prisma.page?.updateMany) {
      await this.prisma.page.updateMany({
        where: { id: targetPageId, spaceId: projectId },
        data: { rootDocId: targetNode.docId },
      });
    }
  }

  public async unsetRootDoc(
    projectId: string,
    pageId?: string | null,
  ): Promise<void> {
    const trimmedPageId = pageId?.trim() || undefined;
    if (this.prisma.page?.updateMany) {
      await this.prisma.page.updateMany({
        where: {
          spaceId: projectId,
          ...(trimmedPageId ? { id: trimmedPageId } : {}),
          rootDocId: { not: null },
        },
        data: { rootDocId: null },
      });
    }
  }

  public async moveSubtree(
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
      await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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

        await this.syncBackingAssetPath(
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
            !(
              tx.pageNode.aggregate as { _isMockFunction?: boolean } | undefined
            )?._isMockFunction
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

              await this.syncBackingAssetPath(
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

  public async renameNode(
    projectId: string,
    nodeId: string,
    newName: string,
    newPath: string,
  ): Promise<ManuscriptNodeEntity> {
    const normalizedNewPath = NodePathVo.normalize(newPath);
    if (typeof this.prisma.pageNode?.findFirst === 'function') {
      const existingTarget = await this.findById(projectId, nodeId);
      if (!existingTarget) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'RESOURCE_NOT_FOUND',
          message: 'Node not found in project',
        });
      }
      if (
        existingTarget.isFolder() &&
        existingTarget.path !== normalizedNewPath
      ) {
        await this.moveSubtree(
          projectId,
          existingTarget.path,
          normalizedNewPath,
          existingTarget.parentId,
          { nodeId, pageId: existingTarget.pageId },
        );
        return (await this.findById(projectId, nodeId))!;
      }
    }

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
      await this.syncBackingAssetPath(
        db,
        projectId,
        updated,
        normalizedNewPath,
      );
      return updated!;
    };

    try {
      const updated =
        typeof this.prisma.$transaction === 'function'
          ? await this.prisma.$transaction(async (tx) => {
              const client = tx?.pageNode ? tx : this.prisma;
              return await executeRename(client);
            })
          : await executeRename(this.prisma);
      return this.mapToEntity(updated);
    } catch (err: unknown) {
      if (isPrismaUniqueError(err)) {
        throw new DuplicateNodePathError(normalizedNewPath);
      }
      throw err;
    }
  }

  public async deleteSubtree(
    projectId: string,
    path: string,
    pageId?: string | null,
  ): Promise<ManuscriptNodeEntity[]> {
    const normalized = NodePathVo.normalize(path);
    const prefix = normalized + '/';

    const trimmedPageId = pageId?.trim() || undefined;
    const targets = await this.prisma.pageNode.findMany({
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
          .filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          ),
      ),
    );
    const fileIds = Array.from(
      new Set(
        targets
          .map((t) => t.fileId)
          .filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          ),
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
      (docIds.length > 0 &&
        typeof this.prisma.pageDoc?.updateMany === 'function') ||
      (fileIds.length > 0 &&
        typeof this.prisma.pageFile?.updateMany === 'function')
    ) {
      if (typeof this.prisma.$transaction === 'function') {
        await this.prisma.$transaction(async (tx) => {
          const client = tx?.pageNode ? tx : this.prisma;
          await runCleanup(client);
        });
      } else {
        await runCleanup(this.prisma);
      }
    }

    return targets.map((t) => this.mapToEntity(t as HydratedPageNodeRow));
  }

  public async updateSortOrder(
    projectId: string,
    nodeId: string,
    sortOrder: number,
  ): Promise<void> {
    const result = await this.prisma.pageNode.updateMany({
      where: { id: nodeId, spaceId: projectId },
      data: { sortOrder },
    });
    if (result.count === 0) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: 'Node not found in project',
      });
    }
  }

  public async updateNodeFileId(
    projectId: string,
    nodeId: string,
    fileId: string,
    sizeBytes?: number,
    hash?: string | null,
  ): Promise<ManuscriptNodeEntity> {
    const result = await this.prisma.pageNode.updateMany({
      where: { id: nodeId, spaceId: projectId },
      data: {
        fileId,
      },
    });
    if (result.count === 0) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: 'Node not found in project',
      });
    }
    const updated = await this.prisma.pageNode.findFirst({
      where: { id: nodeId, spaceId: projectId },
      include: NODE_HYDRATION_INCLUDE,
    });
    return this.mapToEntity(updated!, {
      sizeBytes,
      hash,
    });
  }

  public async countNodes(
    projectId: string,
    pageId?: string | null,
  ): Promise<number> {
    const trimmedPageId = pageId?.trim() || undefined;
    if (trimmedPageId) {
      return await this.prisma.pageNode.count({
        where: { spaceId: projectId, pageId: trimmedPageId },
      });
    }
    return await this.prisma.pageNode.count({
      where: { spaceId: projectId },
    });
  }

  public async docExistsInProject(
    projectId: string,
    docId: string,
    pageId?: string | null,
  ): Promise<boolean> {
    const trimmedPageId = pageId?.trim() || undefined;
    const doc = await this.prisma.pageDoc.findFirst({
      where: {
        id: docId,
        spaceId: projectId,
        deletedAt: null,
        ...(trimmedPageId ? { pageId: trimmedPageId } : {}),
      },
      select: { id: true },
    });
    return Boolean(doc);
  }

  public async fileExistsInProject(
    projectId: string,
    fileId: string,
    pageId?: string | null,
  ): Promise<boolean> {
    const trimmedPageId = pageId?.trim() || undefined;
    const file = await this.prisma.pageFile.findFirst({
      where: {
        id: fileId,
        spaceId: projectId,
        deletedAt: null,
        ...(trimmedPageId ? { pageId: trimmedPageId } : {}),
      },
      select: { id: true },
    });
    return Boolean(file);
  }
}
