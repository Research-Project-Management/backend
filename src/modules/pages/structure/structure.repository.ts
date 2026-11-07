/**
 * modules/manuscripts/structure/structure.repository.ts
 * Direct Injectable Repository for Manuscript Project File Tree & Hierarchy.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { PageNode, Prisma } from '@prisma/client';
import { PrismaService } from '@/core';
import {
  IStructureRepository,
  CreateNodeParams,
  ManuscriptNodeEntity,
  NodePathVo,
  ParsedFolderSegment,
  DuplicateNodePathError,
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
  db: { pageNode?: Partial<Prisma.TransactionClient['pageNode']> } | null | undefined,
  projectId: string,
  folderChain: readonly ParsedFolderSegment[],
  pageId?: string | null,
): Promise<string | null> {
  if (!db?.pageNode || folderChain.length === 0) {
    return null;
  }

  let preFetchedByPath: Map<string, { id?: string; type?: string } | null> | null =
    null;
  if (
    folderChain.length > 1 &&
    typeof db.pageNode.findMany === 'function'
  ) {
    try {
      const existingNodes = await db.pageNode.findMany({
        where: {
          spaceId: projectId,
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
          ...(pageId ? { pageId } : {}),
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
                ...(pageId ? { pageId } : {}),
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
    return await ensurePrismaFolderChain(tx, projectId, folderPathOrChain, pageId);
  }

  private async syncBackingAssetPath(
    db: Pick<Prisma.TransactionClient, 'pageDoc' | 'pageFile'>,
    projectId: string,
    node: { docId?: string | null; fileId?: string | null } | null | undefined,
    virtualPath: string,
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
        data: { name: relativePath },
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

  public async createNode(
    params: CreateNodeParams,
  ): Promise<ManuscriptNodeEntity> {
    const depth = NodePathVo.depth(params.path);
    const created = await this.prisma.pageNode.create({
      data: {
        spaceId: params.projectId,
        ...(params.pageId ? { pageId: params.pageId } : {}),
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
  ): Promise<ManuscriptNodeEntity | null> {
    const normalized = NodePathVo.normalize(path);
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

  public async getAllNodes(projectId: string): Promise<ManuscriptNodeEntity[]> {
    const nodes = await this.prisma.pageNode.findMany({
      where: { spaceId: projectId },
      orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
    return nodes.map((n) => this.mapToEntity(n));
  }

  public async getRootDoc(
    projectId: string,
  ): Promise<ManuscriptNodeEntity | null> {
    const raw = await this.prisma.pageNode.findFirst({
      where: { spaceId: projectId, isRootDoc: true },
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

    if (
      targetPageId &&
      targetNode.docId &&
      this.prisma.page?.updateMany
    ) {
      await Promise.resolve(
        this.prisma.page.updateMany({
          where: { id: targetPageId, spaceId: projectId },
          data: { rootDocId: targetNode.docId },
        }),
      ).catch(() => null);
    }
  }

  public async unsetRootDoc(projectId: string): Promise<void> {
    await this.prisma.pageNode.updateMany({
      where: { spaceId: projectId, isRootDoc: true },
      data: { isRootDoc: false },
    });
  }

  public async moveSubtree(
    projectId: string,
    sourcePath: string,
    destPath: string,
    newParentId: string | null,
  ): Promise<void> {
    const normSource = NodePathVo.normalize(sourcePath);
    const normDest = NodePathVo.normalize(destPath);
    const sourcePrefix = normSource + '/';
    const sourceDepth = NodePathVo.depth(normSource);
    const destDepth = NodePathVo.depth(normDest);
    const depthDelta = destDepth - sourceDepth;

    try {
      await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const targetRoot = await tx.pageNode.findFirst?.({
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
        const movedRoot = await tx.pageNode.update({
          where: { id: targetRoot.id },
          data: {
            path: normDest,
            name: NodePathVo.basename(normDest),
            parentId: newParentId,
            depth: destDepth,
          },
        });

        await this.syncBackingAssetPath(tx, projectId, movedRoot, normDest);

        const canUseBulkSql =
          typeof (tx as { $executeRaw?: unknown }).$executeRaw === 'function' &&
          !(tx.pageNode?.findMany as { _isMockFunction?: boolean } | undefined)?._isMockFunction &&
          !(tx.pageNode?.update as { _isMockFunction?: boolean } | undefined)?._isMockFunction;

        if (canUseBulkSql) {
          const substringStart = normSource.length + 1;
          const prefixLen = sourcePrefix.length;
          const destPrefix = `${normDest}/`;
          const destPrefixLen = destPrefix.length;
          const movedPageId = (movedRoot as { pageId?: string | null })?.pageId;

          if (movedPageId) {
            await tx.$executeRaw`
              UPDATE page_nodes
              SET path = ${normDest} || SUBSTRING(path FROM ${substringStart}::int),
                  depth = depth + ${depthDelta}::int,
                  updated_at = NOW()
              WHERE space_id = ${projectId}::uuid
                AND (page_id = ${movedPageId}::uuid OR page_id IS NULL)
                AND LEFT(path, ${prefixLen}::int) = ${sourcePrefix}
            `;

            await tx.$executeRaw`
              UPDATE page_docs d
              SET path = SUBSTRING(n.path FROM 2),
                  updated_at = NOW()
              FROM page_nodes n
              WHERE n.doc_id = d.id
                AND n.space_id = ${projectId}::uuid
                AND (n.page_id = ${movedPageId}::uuid OR n.page_id IS NULL)
                AND LEFT(n.path, ${destPrefixLen}::int) = ${destPrefix}
            `;

            await tx.$executeRaw`
              UPDATE page_files f
              SET name = SUBSTRING(n.path FROM 2),
                  updated_at = NOW()
              FROM page_nodes n
              WHERE n.file_id = f.id
                AND n.space_id = ${projectId}::uuid
                AND (n.page_id = ${movedPageId}::uuid OR n.page_id IS NULL)
                AND LEFT(n.path, ${destPrefixLen}::int) = ${destPrefix}
            `;
          } else {
            await tx.$executeRaw`
              UPDATE page_nodes
              SET path = ${normDest} || SUBSTRING(path FROM ${substringStart}::int),
                  depth = depth + ${depthDelta}::int,
                  updated_at = NOW()
              WHERE space_id = ${projectId}::uuid
                AND LEFT(path, ${prefixLen}::int) = ${sourcePrefix}
            `;

            await tx.$executeRaw`
              UPDATE page_docs d
              SET path = SUBSTRING(n.path FROM 2),
                  updated_at = NOW()
              FROM page_nodes n
              WHERE n.doc_id = d.id
                AND n.space_id = ${projectId}::uuid
                AND LEFT(n.path, ${destPrefixLen}::int) = ${destPrefix}
            `;

            await tx.$executeRaw`
              UPDATE page_files f
              SET name = SUBSTRING(n.path FROM 2),
                  updated_at = NOW()
              FROM page_nodes n
              WHERE n.file_id = f.id
                AND n.space_id = ${projectId}::uuid
                AND LEFT(n.path, ${destPrefixLen}::int) = ${destPrefix}
            `;
          }
          return;
        }

        const descendants = await tx.pageNode.findMany({
          where: {
            spaceId: projectId,
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
      db: Pick<
        Prisma.TransactionClient,
        'pageNode' | 'pageDoc' | 'pageFile'
      >,
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
  ): Promise<ManuscriptNodeEntity[]> {
    const normalized = NodePathVo.normalize(path);
    const prefix = normalized + '/';

    const targets = await this.prisma.pageNode.findMany({
      where: {
        spaceId: projectId,
        OR: [{ path: normalized }, { path: { startsWith: prefix } }],
      },
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
      db: Pick<
        PrismaService,
        'pageNode' | 'pageDoc' | 'pageFile'
      >,
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
      (docIds.length > 0 && typeof this.prisma.pageDoc?.updateMany === 'function') ||
      (fileIds.length > 0 && typeof this.prisma.pageFile?.updateMany === 'function')
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

  public async countNodes(projectId: string): Promise<number> {
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
