/**
 * modules/pages/core/services/page/page-trash.ts
 * Business: Soft-deleting pages/files, listing trash items, and restoring deleted items.
 */

import * as crypto from 'crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, PageDoc, PageNode } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService, isUuid } from '@/core';
import { type IFilesPort } from '@/modules/files/types/files.type';
import {
  ensureCanonicalPageId,
  getRecordSpaceId,
  isRecordDeleted,
  resolveActiveProjectId,
  resolveCanonicalPageId,
  resolveProjectIdByEntityId,
  resolveSpaceRootDocIds,
  type PageScopeDbClient,
} from '../../core/utils/page-scope';
import { NodePathVo } from '@/modules/pages/core/utils/node-path';
import { ensurePrismaFolderChain } from '@/modules/pages/structure/structure.repository';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { hydratePageDocLines } from '@/modules/pages/core/utils/doc-occ.helper';
import type { PageLifecycleContext } from './content.service';
import type { PageFilesTransferContext } from './file.service';

export async function deletePageHelper(
  ctx: PageLifecycleContext,
  pageId: string,
  authorizedProjectId?: string | { id: string } | null,
) {
  if (isUuid(pageId)) {
    try {
      const targetProjectId = resolveActiveProjectId(authorizedProjectId);
      const pageRow = ctx.prisma.page?.findUnique
        ? await Promise.resolve(
            ctx.prisma.page.findUnique({
              where: { id: pageId },
              select: {
                id: true,
                spaceId: true,
                rootDocId: true,
                deletedAt: true,
              },
            }),
          ).catch(() => null)
        : null;
      const doc = targetProjectId
        ? await ctx.pageScopeRepo.findDocInProject(targetProjectId, pageId)
        : await ctx.prisma.pageDoc.findUnique({
            where: { id: pageId },
          });

      // Case 1: Deleting a Page Aggregate Root (even if rootDocId changed or original doc was already removed)
      if (
        pageRow &&
        (!targetProjectId ||
          !pageRow.spaceId ||
          pageRow.spaceId === targetProjectId)
      ) {
        const aggregateSpaceId = pageRow.spaceId || targetProjectId || '';
        const [activeDocs, activeFiles] = await Promise.all([
          ctx.prisma.pageDoc?.findMany
            ? Promise.resolve(
                ctx.prisma.pageDoc.findMany({
                  where: {
                    pageId: pageRow.id,
                    ...(aggregateSpaceId ? { spaceId: aggregateSpaceId } : {}),
                    deletedAt: null,
                  },
                  select: { id: true },
                }),
              ).catch(() => [])
            : Promise.resolve([]),
          ctx.prisma.pageFile?.findMany
            ? Promise.resolve(
                ctx.prisma.pageFile.findMany({
                  where: {
                    pageId: pageRow.id,
                    ...(aggregateSpaceId ? { spaceId: aggregateSpaceId } : {}),
                    deletedAt: null,
                  },
                  select: {
                    id: true,
                    sizeBytes: true,
                    blobId: true,
                    hash: true,
                  },
                }),
              ).catch(() => [])
            : Promise.resolve([]),
        ]);
        const deletedDocIds = (activeDocs || []).map((d) => d.id);
        const deletedFileIds = (activeFiles || []).map((f) => f.id);

        const deletedAt = new Date();
        // Sync lastKnownPath from active PageNodes onto PageDoc/PageFile and preserve
        // page_nodes rows (including empty FOLDERs) scoped under pageRow.id so restoring
        // the Page from Trash restores its entire folder hierarchy without loss.
        const pageNodes = ctx.prisma.pageNode?.findMany
          ? await Promise.resolve(
              ctx.prisma.pageNode.findMany({
                where: {
                  pageId: pageRow.id,
                  ...(aggregateSpaceId ? { spaceId: aggregateSpaceId } : {}),
                },
                select: {
                  id: true,
                  path: true,
                  docId: true,
                  fileId: true,
                },
              }),
            ).catch(() => [])
          : [];

        const pathSyncOps: Promise<unknown>[] = [];
        for (const n of pageNodes || []) {
          const relPath = NodePathVo.toRelative(n.path || '');
          if (!relPath) continue;
          if (n.docId && ctx.prisma.pageDoc?.updateMany) {
            pathSyncOps.push(
              Promise.resolve(
                ctx.prisma.pageDoc.updateMany({
                  where: { id: n.docId, spaceId: aggregateSpaceId },
                  data: { lastKnownPath: relPath },
                }),
              ).catch(() => null),
            );
          } else if (n.fileId && ctx.prisma.pageFile?.updateMany) {
            pathSyncOps.push(
              Promise.resolve(
                ctx.prisma.pageFile.updateMany({
                  where: { id: n.fileId, spaceId: aggregateSpaceId },
                  data: { lastKnownPath: relPath },
                }),
              ).catch(() => null),
            );
          }
        }
        if (pathSyncOps.length > 0) {
          await Promise.all(pathSyncOps);
        }

        await Promise.all([
          ctx.prisma.page.updateMany({
            where: {
              id: pageRow.id,
              ...(aggregateSpaceId ? { spaceId: aggregateSpaceId } : {}),
            },
            data: { deletedAt },
          }),
          ctx.prisma.pageDoc
            .updateMany({
              where: {
                pageId: pageRow.id,
                ...(aggregateSpaceId ? { spaceId: aggregateSpaceId } : {}),
                deletedAt: null,
              },
              data: { deletedAt },
            })
            .catch(() => null),
          ctx.prisma.pageFile
            ?.updateMany?.({
              where: {
                pageId: pageRow.id,
                ...(aggregateSpaceId ? { spaceId: aggregateSpaceId } : {}),
                deletedAt: null,
              },
              data: { deletedAt },
            })
            .catch(() => null),
        ]);

        if (aggregateSpaceId && deletedDocIds.length > 0) {
          await ctx.domainEventBus.publish({
            type: 'manuscript.nodes.deleted',
            projectId: aggregateSpaceId,
            deletedDocIds,
            deletedFileIds,
            hadRootDoc: true,
            occurredAt: Date.now(),
          });
        }

        if (aggregateSpaceId) {
          // NOTE: Do NOT emit 'pages.page.deleted' on soft-delete so CAS blobs remain intact for restore.
          // Blob ref-counts & storage quota are reclaimed only on permanent purge (`purgePagePermanentlyHelper`).
          ctx.eventEmitter?.emit('pages.file-tree.change', {
            projectId: aggregateSpaceId,
            pageId: pageRow.id,
            change: {
              action: 'delete',
              node: { id: pageRow.id },
            },
          });
        }
        return { success: true };
      }

      // Case 2: Deleting a single PageDoc (never kills parent Page Aggregate Root if docId !== pageRow.id)
      if (doc) {
        const docProjectId = getRecordSpaceId(doc);
        const rootDocIds = await resolveSpaceRootDocIds(
          ctx.prisma,
          docProjectId,
          doc.pageId,
        );
        const deletedRootDoc = rootDocIds.has(doc.id);

        const existingDocNode = ctx.prisma.pageNode?.findFirst
          ? await Promise.resolve(
              ctx.prisma.pageNode.findFirst({
                where: {
                  spaceId: docProjectId,
                  OR: [{ docId: doc.id }, { id: pageId }],
                },
                select: { path: true },
              }),
            ).catch(() => null)
          : null;
        const preservedRelPath = existingDocNode?.path
          ? NodePathVo.toRelative(existingDocNode.path)
          : undefined;

        await Promise.all([
          ctx.docstoreService.patchDoc(docProjectId, doc.id, {
            deleted: true,
            deletedAt: new Date().toISOString(),
            ...(preservedRelPath ? { path: preservedRelPath } : {}),
          }),
          ctx.prisma.pageNode
            .deleteMany({
              where: {
                spaceId: docProjectId,
                OR: [{ docId: doc.id }, { id: pageId }],
              },
            })
            .catch(() => null),
        ]);

        if (deletedRootDoc) {
          const docPageId = doc.pageId;
          if (ctx.prisma.page?.updateMany) {
            await Promise.resolve(
              ctx.prisma.page.updateMany({
                where: {
                  spaceId: docProjectId,
                  ...(docPageId ? { id: docPageId } : {}),
                  rootDocId: doc.id,
                },
                data: { rootDocId: null },
              }),
            ).catch(() => null);
          }
          const nextRootCandidate = await ctx.prisma.pageNode
            .findFirst({
              where: {
                spaceId: docProjectId,
                ...(docPageId ? { pageId: docPageId } : {}),
                type: 'DOC',
                name: { endsWith: '.tex' },
              },
              orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }],
            })
            .catch(() => null);
          if (nextRootCandidate?.docId && ctx.prisma.page?.updateMany) {
            await Promise.resolve(
              ctx.prisma.page.updateMany({
                where: {
                  spaceId: docProjectId,
                  id: docPageId || nextRootCandidate.pageId,
                },
                data: { rootDocId: nextRootCandidate.docId },
              }),
            ).catch(() => null);
          }
        }

        await ctx.domainEventBus.publish({
          type: 'manuscript.nodes.deleted',
          projectId: docProjectId,
          deletedDocIds: [doc.id],
          deletedFileIds: [],
          hadRootDoc: deletedRootDoc,
          occurredAt: Date.now(),
        });

        ctx.eventEmitter?.emit('pages.file-tree.change', {
          projectId: docProjectId,
          change: {
            action: 'delete',
            node: { id: pageId, docId: doc.id },
          },
        });
      }
    } catch {
      // Fallback
    }
  }
  return { success: true };
}

export async function getDeletedFilesHelper(
  prisma: PrismaService,
  pageId: string,
  authorizedProjectId?: string | { id: string } | null,
) {
  const projectId =
    resolveActiveProjectId(authorizedProjectId) ||
    (await resolveProjectIdByEntityId(prisma, pageId));

  if (!projectId) {
    return { files: [] };
  }

  const canonicalPageId = await resolveCanonicalPageId(
    prisma,
    projectId,
    pageId,
  );

  const [deletedDocs, deletedFiles] = await Promise.all([
    prisma.pageDoc.findMany({
      where: {
        spaceId: projectId,
        ...(canonicalPageId ? { pageId: canonicalPageId } : {}),
        deletedAt: { not: null },
      },
      select: {
        id: true,
        lastKnownPath: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    }),
    prisma.pageFile.findMany({
      where: {
        spaceId: projectId,
        ...(canonicalPageId ? { pageId: canonicalPageId } : {}),
        deletedAt: { not: null },
      },
      select: {
        id: true,
        lastKnownPath: true,
        sizeBytes: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    }),
  ]);

  const files = [
    ...deletedDocs.map((d) => ({
      id: d.id,
      pageId,
      title: d.lastKnownPath?.replace(/^\//, '') || 'document.tex',
      path: d.lastKnownPath,
      type: 'DOC',
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    })),
    ...deletedFiles.map((f) => ({
      id: f.id,
      pageId,
      title: f.lastKnownPath,
      path: `/${f.lastKnownPath}`,
      type: 'FILE',
      size: Number(f.sizeBytes || 0),
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    })),
  ];

  return { files };
}

async function ensureRestoredAssetNode(
  prisma: PrismaService,
  params: {
    projectId: string;
    pageId?: string | null;
    rawPath: string;
    fallbackLeaf: string;
    type: 'DOC' | 'FILE';
    assetId: string;
  },
): Promise<{ node: PageNode; parsed: ReturnType<typeof NodePathVo.parse> }> {
  const parsed = NodePathVo.parse(params.rawPath, params.fallbackLeaf);
  const existingNode = await prisma.pageNode.findFirst({
    where: {
      spaceId: params.projectId,
      ...(params.type === 'DOC'
        ? { docId: params.assetId }
        : { fileId: params.assetId }),
    },
  });
  if (existingNode) {
    return { node: existingNode, parsed };
  }

  const canonicalPageId = await ensureCanonicalPageId(
    prisma,
    params.projectId,
    params.pageId,
  );

  const parentId = await ensurePrismaFolderChain(
    prisma,
    params.projectId,
    parsed.folderChain,
    canonicalPageId,
  );

  let pathConflict = await prisma.pageNode.findFirst?.({
    where: {
      spaceId: params.projectId,
      pageId: canonicalPageId,
      path: parsed.normalizedPath,
    },
  });

  let finalLeafName = parsed.leafName;
  let cleanPath = parsed.normalizedPath;
  let counter = 1;
  while (
    pathConflict &&
    (params.type === 'DOC' ? pathConflict.docId : pathConflict.fileId) !==
      params.assetId
  ) {
    const suffix = counter === 1 ? ' (Restored)' : ` (Restored ${counter})`;
    finalLeafName = NodePathVo.withSuffixBeforeExt(parsed.leafName, suffix);
    cleanPath =
      parsed.parentPath && parsed.parentPath !== '/'
        ? `${parsed.parentPath}/${finalLeafName}`
        : `/${finalLeafName}`;
    counter++;
    pathConflict =
      counter <= 50
        ? await prisma.pageNode.findFirst?.({
            where: {
              spaceId: params.projectId,
              pageId: canonicalPageId,
              path: cleanPath,
            },
          })
        : null;
  }

  const relativeCleanPath = NodePathVo.toRelative(cleanPath);
  if (relativeCleanPath !== parsed.relativePath) {
    if (params.type === 'DOC') {
      await prisma.pageDoc
        ?.updateMany?.({
          where: { id: params.assetId, spaceId: params.projectId },
          data: { lastKnownPath: relativeCleanPath },
        })
        ?.catch(() => null);
    } else {
      await prisma.pageFile
        ?.updateMany?.({
          where: { id: params.assetId, spaceId: params.projectId },
          data: { lastKnownPath: relativeCleanPath },
        })
        ?.catch(() => null);
    }
  }

  const node = await prisma.pageNode.create({
    data: {
      spaceId: params.projectId,
      pageId: canonicalPageId,
      parentId,
      name: finalLeafName,
      path: cleanPath,
      depth: parsed.depth,
      type: params.type,
      ...(params.type === 'DOC'
        ? { docId: params.assetId }
        : { fileId: params.assetId }),
    },
  });

  return { node, parsed: NodePathVo.parse(cleanPath, finalLeafName) };
}

export async function restoreDeletedDocOrFile(
  prisma: PrismaService,
  docstoreService: DocstoreService,
  eventEmitter: EventEmitter2 | undefined,
  pageId: string,
  targetProjectId?: string,
  filesPort?: IFilesPort,
) {
  // Case 0: Restoring a soft-deleted Page Aggregate Root (restores Page + all child docs/files + tree nodes)
  const deletedPage = prisma.page?.findUnique
    ? await Promise.resolve(
        prisma.page.findUnique({
          where: { id: pageId },
          select: {
            id: true,
            spaceId: true,
            title: true,
            rootDocId: true,
            deletedAt: true,
          },
        }),
      ).catch(() => null)
    : null;

  if (
    deletedPage &&
    deletedPage.deletedAt &&
    (!targetProjectId || deletedPage.spaceId === targetProjectId)
  ) {
    const spaceId = deletedPage.spaceId;
    const [pageDocs, pageFiles] = await Promise.all([
      prisma.pageDoc.findMany({
        where: { pageId: deletedPage.id, spaceId },
        select: { id: true, lastKnownPath: true },
      }),
      prisma.pageFile.findMany({
        where: { pageId: deletedPage.id, spaceId },
        select: { id: true, lastKnownPath: true },
      }),
    ]);

    await Promise.all([
      prisma.page.update({
        where: { id: deletedPage.id },
        data: { deletedAt: null },
      }),
      prisma.pageDoc.updateMany({
        where: { pageId: deletedPage.id, spaceId },
        data: { deletedAt: null },
      }),
      prisma.pageFile.updateMany({
        where: { pageId: deletedPage.id, spaceId },
        data: { deletedAt: null },
      }),
    ]);

    for (const d of pageDocs) {
      await ensureRestoredAssetNode(prisma, {
        projectId: spaceId,
        pageId: deletedPage.id,
        rawPath: d.lastKnownPath || 'main.tex',
        fallbackLeaf: 'main.tex',
        type: 'DOC',
        assetId: d.id,
      });
    }
    for (const f of pageFiles) {
      await ensureRestoredAssetNode(prisma, {
        projectId: spaceId,
        pageId: deletedPage.id,
        rawPath: f.lastKnownPath || 'restored.bin',
        fallbackLeaf: 'restored.bin',
        type: 'FILE',
        assetId: f.id,
      });
    }

    eventEmitter?.emit('pages.file-tree.change', {
      projectId: spaceId,
      pageId: deletedPage.id,
      change: {
        action: 'create',
        node: { id: deletedPage.id },
      },
    });

    return {
      success: true,
      page: {
        id: deletedPage.id,
        title: deletedPage.title,
        projectId: spaceId,
      },
    };
  }

  const doc = targetProjectId
    ? await prisma.pageDoc.findFirst({
        where: { id: pageId, spaceId: targetProjectId },
      })
    : await prisma.pageDoc.findUnique({
        where: { id: pageId },
      });

  if (doc) {
    const docProjectId = getRecordSpaceId(doc);
    const docPageId = doc.pageId ?? null;
    await docstoreService.patchDoc(docProjectId, pageId, {
      deleted: false,
    });

    const rawDocPath =
      doc.lastKnownPath || (doc as { path?: string }).path || 'restored.tex';
    const { node: existingNode, parsed } = await ensureRestoredAssetNode(
      prisma,
      {
        projectId: docProjectId,
        pageId: docPageId,
        rawPath: rawDocPath,
        fallbackLeaf: 'restored.tex',
        type: 'DOC',
        assetId: doc.id,
      },
    );

    if (docPageId && prisma.page?.updateMany) {
      await Promise.resolve(
        prisma.page.updateMany({
          where: {
            id: docPageId,
            spaceId: docProjectId,
            deletedAt: { not: null },
          },
          data: { deletedAt: null },
        }),
      ).catch(() => undefined);
    }

    if (
      docPageId &&
      /\.(tex|rtex|rnw)$/i.test(parsed.leafName) &&
      prisma.page?.updateMany
    ) {
      await Promise.resolve(
        prisma.page.updateMany({
          where: { id: docPageId, spaceId: docProjectId, rootDocId: null },
          data: { rootDocId: doc.id },
        }),
      ).catch(() => undefined);
    }

    eventEmitter?.emit('pages.file-tree.change', {
      projectId: docProjectId,
      change: {
        action: 'create',
        node: existingNode,
      },
    });

    const lines = await hydratePageDocLines(docstoreService, doc);
    const content = lines.join('\n');

    return {
      success: true,
      page: {
        id: doc.id,
        title: parsed.relativePath,
        content,
        projectId: docProjectId,
      },
    };
  }

  const file = targetProjectId
    ? await prisma.pageFile.findFirst({
        where: { id: pageId, spaceId: targetProjectId },
      })
    : await prisma.pageFile.findUnique({
        where: { id: pageId },
      });

  if (file) {
    const fileProjectId = getRecordSpaceId(file);
    const filePageId = file.pageId ?? null;
    await prisma.pageFile.update({
      where: { id: pageId },
      data: { deletedAt: null },
    });
    // Note: Soft-delete keeps FileBlob CAS ref-counts and SpaceQuota intact while in Trash,
    // so restoring a soft-deleted PageFile must NOT re-acquire blob or re-reserve quota.

    const rawFilePath =
      file.lastKnownPath || (file as { name?: string }).name || 'restored.bin';
    const { node: existingNode } = await ensureRestoredAssetNode(prisma, {
      projectId: fileProjectId,
      pageId: filePageId,
      rawPath: rawFilePath,
      fallbackLeaf: 'restored.bin',
      type: 'FILE',
      assetId: file.id,
    });

    eventEmitter?.emit('pages.file-tree.change', {
      projectId: fileProjectId,
      change: {
        action: 'create',
        node: existingNode,
      },
    });

    return {
      success: true,
      page: {
        id: file.id,
        title: rawFilePath,
        projectId: fileProjectId,
      },
    };
  }

  throw new NotFoundException({
    statusCode: 404,
    code: 'RESOURCE_NOT_FOUND',
    message: `Document ${pageId} not found`,
  });
}

export async function getTrashPagesHelper(
  prisma: PrismaService,
  spaceId: string,
) {
  if (!isUuid(spaceId) || !prisma.page?.findMany) {
    return { pages: [], total: 0 };
  }
  const rows = await prisma.page.findMany({
    where: { spaceId, deletedAt: { not: null } },
    orderBy: { deletedAt: 'desc' },
  });

  const creatorIds = Array.from(
    new Set(
      rows.map((p) => p.createdById).filter((id): id is string => Boolean(id)),
    ),
  );
  const creators =
    creatorIds.length > 0 && prisma.user?.findMany
      ? await Promise.resolve(
          prisma.user.findMany({
            where: { id: { in: creatorIds } },
            select: {
              id: true,
              email: true,
              profile: { select: { name: true } },
            },
          }),
        ).catch(() => [])
      : [];
  const creatorById = new Map(creators.map((u) => [u.id, u]));

  const pages = rows.map((page) => {
    const creator = page.createdById
      ? creatorById.get(page.createdById)
      : undefined;
    return {
      id: page.id,
      title: page.title || 'Untitled',
      description: page.description ?? '',
      status: page.status,
      thumbnail: page.thumbnail ?? undefined,
      pdfThumbnail: page.thumbnail ?? undefined,
      projectId: spaceId,
      spaceId,
      author: {
        id: creator?.id ?? page.createdById ?? undefined,
        name:
          creator?.profile?.name || creator?.email?.split('@')[0] || 'Author',
      },
      labels: [],
      deletedAt: page.deletedAt?.toISOString() ?? null,
      createdAt: page.createdAt.toISOString(),
      updatedAt: page.updatedAt.toISOString(),
    };
  });

  return { pages, total: pages.length };
}

export async function purgePagePermanentlyHelper(
  ctx: PageLifecycleContext,
  pageId: string,
  authorizedProjectId?: string | { id: string } | null,
) {
  if (!isUuid(pageId)) {
    throw new NotFoundException(`Page ${pageId} not found`);
  }
  const targetProjectId = resolveActiveProjectId(authorizedProjectId);
  const pageRow = await ctx.prisma.page.findUnique({
    where: { id: pageId },
    select: { id: true, spaceId: true, deletedAt: true },
  });
  if (!pageRow || (targetProjectId && pageRow.spaceId !== targetProjectId)) {
    throw new NotFoundException(`Page ${pageId} not found`);
  }
  if (!pageRow.deletedAt) {
    throw new BadRequestException(
      'Move page to trash before permanently deleting it.',
    );
  }

  const spaceId = pageRow.spaceId;
  const [pageFiles, pageDocs] = await Promise.all([
    ctx.prisma.pageFile.findMany({
      where: { pageId: pageRow.id, spaceId },
      select: { id: true, sizeBytes: true, blobId: true, hash: true },
    }),
    ctx.prisma.pageDoc.findMany({
      where: { pageId: pageRow.id, spaceId },
      select: { id: true, inStorage: true, storageKey: true },
    }),
  ]);

  // Evict live Yjs collaboration sessions before hard-deleting docs
  if (pageDocs.length > 0) {
    await ctx.domainEventBus?.publish({
      type: 'manuscript.nodes.deleted',
      projectId: spaceId,
      deletedDocIds: pageDocs.map((d) => d.id),
      deletedFileIds: pageFiles.map((f) => f.id),
      hadRootDoc: true,
      occurredAt: Date.now(),
    });
  }

  await ctx.prisma.$transaction(async (tx) => {
    await tx.pageLabel.deleteMany({ where: { pageId: pageRow.id } });
    await tx.pageNode.deleteMany({ where: { pageId: pageRow.id, spaceId } });
    await tx.pageFile.deleteMany({ where: { pageId: pageRow.id, spaceId } });
    await tx.pageDoc.deleteMany({ where: { pageId: pageRow.id, spaceId } });
    await tx.page.delete({ where: { id: pageRow.id } });
  });

  // Reclaim CAS blob ref-counts, cold-tier S3 doc objects, and storage quota only on permanent purge
  ctx.eventEmitter?.emit('pages.page.deleted', {
    projectId: spaceId,
    pageId: pageRow.id,
    deletedFiles: pageFiles,
    deletedDocs: pageDocs,
  });

  return { success: true, purgedPageId: pageRow.id };
}
