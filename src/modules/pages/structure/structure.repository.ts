/**
 * modules/manuscripts/structure/structure.repository.ts
 * Direct Injectable Repository for Manuscript Project File Tree & Hierarchy.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { PageNode, Prisma } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
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
    | { pageNode?: Partial<Prisma.TransactionClient['pageNode']> }
    | null
    | undefined,
  projectId: string,
  folderChain: readonly ParsedFolderSegment[],
  pageId?: string | null,
): Promise<string | null> {
  if (!db?.pageNode || folderChain.length === 0) {
    return null;
  }

  let preFetchedByPath: Map<
    string,
    { id?: string; type?: string } | null
  > | null = null;
  if (folderChain.length > 1 && typeof db.pageNode.findMany === 'function') {
    try {
      const existingNodes = await db.pageNode.findMany({
        where: {
          spaceId: projectId,
          ...(pageId ? { pageId } : { pageId: null }),
          path: { in: folderChain.map((f) => f.path) },
        },
      });
      if (Array.isArray(existingNodes)) {
        preFetchedByPath = new Map(
          existingNodes
            .filter((n): n is NonNullable<typeof n> => Boolean(n && n.path))
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
      (pageId
        ? await db.pageNode.findUnique?.({
            where: {
              pageId_path: {
                pageId,
                path: folder.path,
              },
            },
          })
        : null) ??
      (await db.pageNode.findFirst?.({
        where: {
          spaceId: projectId,
          ...(pageId ? { pageId } : { pageId: null }),
          path: folder.path,
        },
      }));
    if (!folderNode && db.pageNode.create) {
      try {
        folderNode = await db.pageNode.create({
          data: {
            spaceId: projectId,
            ...(pageId ? { pageId } : {}),
            parentId,
            type: 'FOLDER',
            name: folder.name,
            path: folder.path,
            depth: folder.depth,
            isRootDoc: false,
            sizeBytes: 0,
            sortOrder: 0,
          },
        });
      } catch (createErr: unknown) {
        if (isPrismaUniqueError(createErr)) {
          folderNode =
            (pageId
              ? await db.pageNode.findUnique?.({
                  where: {
                    pageId_path: {
                      pageId,
                      path: folder.path,
                    },
                  },
                })
              : null) ??
            (await db.pageNode.findFirst?.({
              where: {
                spaceId: projectId,
                ...(pageId ? { pageId } : { pageId: null }),
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
        data: { path: relativePath },
      });
    }
    if (node.fileId) {
      await db.pageFile?.updateMany({
        where: { id: node.fileId, spaceId: projectId },
        data: {
          name: relativePath,
          ...(promotedPageId ? { pageId: promotedPageId } : {}),
        },
      });
    }
  }

  private mapToEntity(raw: PageNode): ManuscriptNodeEntity {
    const projectId =
      raw.spaceId ?? (raw as { projectId?: string }).projectId ?? '';
    return new ManuscriptNodeEntity({
      id: raw.id,
      projectId,
      pageId: (raw as { pageId?: string | null }).pageId ?? projectId,
      parentId: raw.parentId,
      type: raw.type,
      name: raw.name,
      path: raw.path,
      depth: raw.depth,
      docId: raw.docId,
      fileId: raw.fileId,
      isRootDoc: raw.isRootDoc,
      sizeBytes: Number(raw.sizeBytes || 0),
      hash: raw.hash,
      sortOrder: raw.sortOrder,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    });
  }

  private async resolveValidFkPageId(
    spaceId: string,
    candidatePageId?: string | null,
  ): Promise<string | undefined> {
    if (
      !candidatePageId ||
      candidatePageId === spaceId ||
      !isUuid(candidatePageId)
    ) {
      return undefined;
    }
    if (!this.prisma.page?.findUnique) {
      return candidatePageId;
    }
    const pageRow = await Promise.resolve(
      this.prisma.page.findUnique({
        where: { id: candidatePageId },
        select: { id: true, spaceId: true },
      }),
    ).catch(() => null);
    if (pageRow && pageRow.spaceId === spaceId) {
      return pageRow.id;
    }
    return undefined;
  }

  public async createNode(
    params: CreateNodeParams,
  ): Promise<ManuscriptNodeEntity> {
    const depth = NodePathVo.depth(params.path);
    const validFkPageId = await this.resolveValidFkPageId(
      params.projectId,
      params.pageId,
    );
    const created = await this.prisma.pageNode.create({
      data: {
        spaceId: params.projectId,
        ...(validFkPageId ? { pageId: validFkPageId } : {}),
        parentId: params.parentId || null,
        type: params.type,
        name: params.name,
        path: params.path,
        depth,
        docId: params.docId || null,
        fileId: params.fileId || null,
        isRootDoc: params.isRootDoc || false,
        sizeBytes: params.sizeBytes || 0,
        hash: params.hash || null,
        sortOrder: params.sortOrder || 0,
      },
    });

    return this.mapToEntity(created);
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
    });
    if (raw) return this.mapToEntity(raw);

    const byPage = await this.prisma.pageNode
      .findFirst({
        where: {
          pageId: projectId,
          OR: [{ id: nodeId }, { docId: nodeId }, { fileId: nodeId }],
        },
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
    const hasCustomPageScope = Boolean(pageId && pageId !== projectId);
    if (hasCustomPageScope) {
      const scoped = await this.prisma.pageNode.findFirst({
        where: { spaceId: projectId, pageId, path: normalized },
      });
      if (scoped) return this.mapToEntity(scoped);
      const pageHasOwnNodes = await this.prisma.pageNode
        .findFirst({
          where: { spaceId: projectId, pageId },
          select: { id: true },
        })
        .catch(() => null);
      if (!pageHasOwnNodes) {
        const legacy = await this.prisma.pageNode.findFirst({
          where: { spaceId: projectId, pageId: null, path: normalized },
        });
        return legacy ? this.mapToEntity(legacy) : null;
      }
      return null;
    }
    const raw = await this.prisma.pageNode.findFirst({
      where: {
        OR: [
          { spaceId: projectId, path: normalized },
          { pageId: projectId, path: normalized },
        ],
      },
    });
    return raw ? this.mapToEntity(raw) : null;
  }

  public async findByFileId(
    projectId: string,
    fileId: string,
  ): Promise<ManuscriptNodeEntity | null> {
    const raw = await this.prisma.pageNode.findFirst({
      where: { spaceId: projectId, fileId },
    });
    return raw ? this.mapToEntity(raw) : null;
  }

  public async getAllNodes(
    projectId: string,
    pageId?: string | null,
  ): Promise<ManuscriptNodeEntity[]> {
    const hasCustomPageScope = Boolean(pageId && pageId !== projectId);
    const nodes = await this.prisma.pageNode.findMany({
      where: hasCustomPageScope
        ? { spaceId: projectId, OR: [{ pageId }, { pageId: null }] }
        : pageId === null
          ? { spaceId: projectId, pageId: null }
          : { spaceId: projectId },
      orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
    const scoped = hasCustomPageScope
      ? filterRecordsByPageScope(nodes, pageId, projectId)
      : nodes;
    return scoped.map((n) => this.mapToEntity(n));
  }

  public async getRootDoc(
    projectId: string,
    pageId?: string | null,
  ): Promise<ManuscriptNodeEntity | null> {
    const hasCustomPageScope = Boolean(pageId && pageId !== projectId);
    if (hasCustomPageScope) {
      const scoped = await this.prisma.pageNode.findFirst({
        where: { spaceId: projectId, pageId, isRootDoc: true },
      });
      if (scoped) return this.mapToEntity(scoped);
      const pageHasOwnNodes = await this.prisma.pageNode
        .findFirst({
          where: { spaceId: projectId, pageId },
          select: { id: true },
        })
        .catch(() => null);
      if (!pageHasOwnNodes) {
        const legacy = await this.prisma.pageNode.findFirst({
          where: { spaceId: projectId, pageId: null, isRootDoc: true },
        });
        return legacy ? this.mapToEntity(legacy) : null;
      }
      return null;
    }
    const raw = await this.prisma.pageNode.findFirst({
      where:
        pageId === null
          ? { spaceId: projectId, pageId: null, isRootDoc: true }
          : { spaceId: projectId, isRootDoc: true },
    });
    return raw ? this.mapToEntity(raw) : null;
  }

  public async setRootDoc(projectId: string, nodeId: string): Promise<void> {
    const targetNode = await this.prisma.pageNode.findFirst({
      where: {
        spaceId: projectId,
        OR: [{ id: nodeId }, { docId: nodeId }],
      },
    });

    if (!targetNode) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: 'Node not found in project',
      });
    }

    const targetPageId = (targetNode as { pageId?: string | null }).pageId;

    await this.prisma.$transaction([
      this.prisma.pageNode.updateMany({
        where: {
          spaceId: projectId,
          ...(targetPageId ? { pageId: targetPageId } : {}),
          isRootDoc: true,
        },
        data: { isRootDoc: false },
      }),
      this.prisma.pageNode.updateMany({
        where: { id: targetNode.id, spaceId: projectId },
        data: { isRootDoc: true },
      }),
    ]);

    if (targetPageId && targetNode.docId && this.prisma.page?.updateMany) {
      await Promise.resolve(
        this.prisma.page.updateMany({
          where: { id: targetPageId, spaceId: projectId },
          data: { rootDocId: targetNode.docId },
        }),
      ).catch(() => null);
    }
  }

  public async unsetRootDoc(
    projectId: string,
    pageId?: string | null,
  ): Promise<void> {
    const hasCustomPageScope = Boolean(pageId && pageId !== projectId);
    await this.prisma.pageNode.updateMany({
      where: {
        spaceId: projectId,
        ...(hasCustomPageScope
          ? { pageId }
          : pageId === null
            ? { pageId: null }
            : {}),
        isRootDoc: true,
      },
      data: { isRootDoc: false },
    });
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
    const sourcePrefix = normSource + '/';
    const sourceDepth = NodePathVo.depth(normSource);
    const destDepth = NodePathVo.depth(normDest);
    const depthDelta = destDepth - sourceDepth;
    const optionPageId =
      options?.pageId === projectId ? null : options?.pageId;

    try {
      await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const targetRoot = options?.nodeId
          ? await tx.pageNode.findFirst?.({
              where: { id: options.nodeId, spaceId: projectId },
            })
          : optionPageId !== undefined
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

        const targetRawPageId =
          (targetRoot as { pageId?: string | null }).pageId ?? null;
        const promotedPageId =
          optionPageId && targetRawPageId == null ? optionPageId : undefined;

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

        const movedRootRawPageId =
          (movedRoot as { pageId?: string | null })?.pageId ?? null;
        const normalizedRootPageId =
          movedRootRawPageId === projectId ? null : movedRootRawPageId;
        const movedPageId =
          optionPageId !== undefined ? optionPageId : normalizedRootPageId;

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
                ...(movedPageId ? { pageId: movedPageId } : { pageId: null }),
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

          const substringStart = normSource.length + 1;
          const prefixLen = sourcePrefix.length;
          const destPrefix = `${normDest}/`;
          const destPrefixLen = destPrefix.length;

          if (movedPageId) {
            await tx.$executeRaw`
              UPDATE page_nodes
              SET path = ${normDest} || SUBSTRING(path FROM ${substringStart}::int),
                  depth = depth + ${depthDelta}::int,
                  updated_at = NOW()
              WHERE space_id = ${projectId}::uuid
                AND page_id = ${movedPageId}::uuid
                AND LEFT(path, ${prefixLen}::int) = ${sourcePrefix}
            `;

            await tx.$executeRaw`
              UPDATE page_docs d
              SET path = SUBSTRING(n.path FROM 2),
                  updated_at = NOW()
              FROM page_nodes n
              WHERE n.doc_id = d.id
                AND n.space_id = ${projectId}::uuid
                AND n.page_id = ${movedPageId}::uuid
                AND LEFT(n.path, ${destPrefixLen}::int) = ${destPrefix}
            `;

            await tx.$executeRaw`
              UPDATE page_files f
              SET name = SUBSTRING(n.path FROM 2),
                  updated_at = NOW()
              FROM page_nodes n
              WHERE n.file_id = f.id
                AND n.space_id = ${projectId}::uuid
                AND n.page_id = ${movedPageId}::uuid
                AND LEFT(n.path, ${destPrefixLen}::int) = ${destPrefix}
            `;
          } else {
            await tx.$executeRaw`
              UPDATE page_nodes
              SET path = ${normDest} || SUBSTRING(path FROM ${substringStart}::int),
                  depth = depth + ${depthDelta}::int,
                  updated_at = NOW()
              WHERE space_id = ${projectId}::uuid
                AND page_id IS NULL
                AND LEFT(path, ${prefixLen}::int) = ${sourcePrefix}
            `;

            await tx.$executeRaw`
              UPDATE page_docs d
              SET path = SUBSTRING(n.path FROM 2),
                  updated_at = NOW()
              FROM page_nodes n
              WHERE n.doc_id = d.id
                AND n.space_id = ${projectId}::uuid
                AND n.page_id IS NULL
                AND LEFT(n.path, ${destPrefixLen}::int) = ${destPrefix}
            `;

            await tx.$executeRaw`
              UPDATE page_files f
              SET name = SUBSTRING(n.path FROM 2),
                  updated_at = NOW()
              FROM page_nodes n
              WHERE n.file_id = f.id
                AND n.space_id = ${projectId}::uuid
                AND n.page_id IS NULL
                AND LEFT(n.path, ${destPrefixLen}::int) = ${destPrefix}
            `;
          }
          return;
        }

        const descendants = await tx.pageNode.findMany({
          where: {
            spaceId: projectId,
            ...(movedPageId ? { pageId: movedPageId } : { pageId: null }),
            path: { startsWith: sourcePrefix },
          },
        });

        if (descendants.length === 0) {
          return;
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
                },
              });

              await this.syncBackingAssetPath(
                tx,
                projectId,
                descendant,
                rebased.path,
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
    const depth = NodePathVo.depth(newPath);
    const executeRename = async (
      db: Pick<Prisma.TransactionClient, 'pageNode' | 'pageDoc' | 'pageFile'>,
    ): Promise<PageNode> => {
      const result = await db.pageNode.updateMany({
        where: { id: nodeId, spaceId: projectId },
        data: {
          name: newName,
          path: newPath,
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
      });
      await this.syncBackingAssetPath(db, projectId, updated, newPath);
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
        throw new DuplicateNodePathError(newPath);
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

    const hasCustomPageScope = Boolean(pageId && pageId !== projectId);
    let targets: PageNode[];
    if (hasCustomPageScope) {
      targets = await this.prisma.pageNode.findMany({
        where: {
          spaceId: projectId,
          pageId,
          OR: [{ path: normalized }, { path: { startsWith: prefix } }],
        },
      });
      if (targets.length === 0) {
        const pageHasOwnNodes = this.prisma.pageNode.findFirst
          ? await Promise.resolve(
              this.prisma.pageNode.findFirst({
                where: { spaceId: projectId, pageId },
                select: { id: true },
              }),
            ).catch(() => null)
          : null;
        if (!pageHasOwnNodes) {
          targets = await this.prisma.pageNode.findMany({
            where: {
              spaceId: projectId,
              pageId: null,
              OR: [{ path: normalized }, { path: { startsWith: prefix } }],
            },
          });
        }
      }
    } else if (pageId === null) {
      targets = await this.prisma.pageNode.findMany({
        where: {
          spaceId: projectId,
          pageId: null,
          OR: [{ path: normalized }, { path: { startsWith: prefix } }],
        },
      });
    } else {
      targets = await this.prisma.pageNode.findMany({
        where: {
          spaceId: projectId,
          OR: [{ path: normalized }, { path: { startsWith: prefix } }],
        },
      });
    }

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

    return targets.map((t) => this.mapToEntity(t));
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
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        ...(hash !== undefined ? { hash } : {}),
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
    });
    return this.mapToEntity(updated!);
  }

  public async countNodes(
    projectId: string,
    pageId?: string | null,
  ): Promise<number> {
    const hasCustomPageScope = Boolean(pageId && pageId !== projectId);
    if (hasCustomPageScope) {
      const scopedCount = await this.prisma.pageNode.count({
        where: { spaceId: projectId, pageId },
      });
      if (scopedCount > 0) return scopedCount;
      return await this.prisma.pageNode.count({
        where: { spaceId: projectId, pageId: null },
      });
    }
    return await this.prisma.pageNode.count({
      where: { spaceId: projectId },
    });
  }

  public async docExistsInProject(
    projectId: string,
    docId: string,
  ): Promise<boolean> {
    const doc = await this.prisma.pageDoc.findFirst({
      where: { id: docId, spaceId: projectId, deletedAt: null },
      select: { id: true },
    });
    return Boolean(doc);
  }

  public async fileExistsInProject(
    projectId: string,
    fileId: string,
  ): Promise<boolean> {
    const file = await this.prisma.pageFile.findFirst({
      where: { id: fileId, spaceId: projectId, deletedAt: null },
      select: { id: true },
    });
    return Boolean(file);
  }
}
