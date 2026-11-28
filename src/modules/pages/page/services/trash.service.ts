/**
 * modules/pages/page/services/trash.service.ts
 * Domain service handling Page & file soft-deletion, trash listing, restore, and permanent purge.
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PageNode } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService, isUuid } from '@/core';
import {
  NodePathVo,
  PageDomainEventBus,
  ensureCanonicalPageId,
  ensurePrismaFolderChain,
  getRecordSpaceId,
  hydratePageDocLines,
  resolveActiveProjectId,
  resolveCanonicalPageId,
  resolveProjectIdByEntityId,
  resolveSpaceRootDocIds,
} from '@/modules/pages/core';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';

@Injectable()
export class PageTrashService {
  private readonly logger = new Logger(PageTrashService.name);
  private readonly pageScopeRepo: ScopeRepository;
  private readonly domainEventBus: PageDomainEventBus;

  constructor(
    private readonly prisma: PrismaService,
    private readonly docstoreService: DocstoreService,
    @Optional() pageScopeRepo?: ScopeRepository,
    @Optional() domainEventBus?: PageDomainEventBus,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {
    this.pageScopeRepo = pageScopeRepo ?? new ScopeRepository(prisma);
    this.domainEventBus = domainEventBus ?? new PageDomainEventBus();
  }

  public async deletePage(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    if (!isUuid(pageId)) {
      return { success: true };
    }
    try {
      const targetProjectId = resolveActiveProjectId(authorizedProjectId);
      const pageRow = this.prisma.page?.findUnique
        ? await Promise.resolve(
            this.prisma.page.findUnique({
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
        ? await this.pageScopeRepo.findDocInProject(targetProjectId, pageId)
        : await this.prisma.pageDoc.findUnique({
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
        const [activeDocs, activeFiles, pageNodes] = await Promise.all([
          this.prisma.pageDoc?.findMany
            ? Promise.resolve(
                this.prisma.pageDoc.findMany({
                  where: {
                    pageId: pageRow.id,
                    ...(aggregateSpaceId ? { spaceId: aggregateSpaceId } : {}),
                    deletedAt: null,
                  },
                  select: { id: true },
                }),
              ).catch(() => [])
            : Promise.resolve([]),
          this.prisma.pageFile?.findMany
            ? Promise.resolve(
                this.prisma.pageFile.findMany({
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
          this.prisma.pageNode?.findMany
            ? Promise.resolve(
                this.prisma.pageNode.findMany({
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
            : Promise.resolve([]),
        ]);
        const deletedDocIds = (activeDocs || []).map((d) => d.id);
        const deletedFileIds = (activeFiles || []).map((f) => f.id);
        const deletedAt = new Date();

        const pathSyncOps: Promise<unknown>[] = [];
        for (const n of pageNodes || []) {
          const relPath = NodePathVo.toRelative(n.path || '');
          if (!relPath) continue;
          if (n.docId && this.prisma.pageDoc?.updateMany) {
            pathSyncOps.push(
              Promise.resolve(
                this.prisma.pageDoc.updateMany({
                  where: { id: n.docId, spaceId: aggregateSpaceId },
                  data: { lastKnownPath: relPath },
                }),
              ).catch(() => null),
            );
          } else if (n.fileId && this.prisma.pageFile?.updateMany) {
            pathSyncOps.push(
              Promise.resolve(
                this.prisma.pageFile.updateMany({
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
          this.prisma.page.updateMany({
            where: {
              id: pageRow.id,
              ...(aggregateSpaceId ? { spaceId: aggregateSpaceId } : {}),
            },
            data: { deletedAt },
          }),
          this.prisma.pageDoc
            .updateMany({
              where: {
                pageId: pageRow.id,
                ...(aggregateSpaceId ? { spaceId: aggregateSpaceId } : {}),
                deletedAt: null,
              },
              data: { deletedAt },
            })
            .catch(() => null),
          this.prisma.pageFile
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
          await this.domainEventBus.publish({
            type: 'manuscript.nodes.deleted',
            projectId: aggregateSpaceId,
            deletedDocIds,
            deletedFileIds,
            hadRootDoc: true,
            occurredAt: Date.now(),
          });
        }

        if (aggregateSpaceId) {
          this.eventEmitter?.emit('pages.file-tree.change', {
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
          this.prisma,
          docProjectId,
          doc.pageId,
        );
        const deletedRootDoc = rootDocIds.has(doc.id);

        const existingDocNode = this.prisma.pageNode?.findFirst
          ? await Promise.resolve(
              this.prisma.pageNode.findFirst({
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
          this.docstoreService.patchDoc(docProjectId, doc.id, {
            deleted: true,
            deletedAt: new Date().toISOString(),
            ...(preservedRelPath ? { path: preservedRelPath } : {}),
          }),
          this.prisma.pageNode
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
          if (this.prisma.page?.updateMany) {
            await Promise.resolve(
              this.prisma.page.updateMany({
                where: {
                  spaceId: docProjectId,
                  ...(docPageId ? { id: docPageId } : {}),
                  rootDocId: doc.id,
                },
                data: { rootDocId: null },
              }),
            ).catch(() => null);
          }
          const nextRootCandidate = await this.prisma.pageNode
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
          if (nextRootCandidate?.docId && this.prisma.page?.updateMany) {
            await Promise.resolve(
              this.prisma.page.updateMany({
                where: {
                  spaceId: docProjectId,
                  id: docPageId || nextRootCandidate.pageId,
                },
                data: { rootDocId: nextRootCandidate.docId },
              }),
            ).catch(() => null);
          }
        }

        await this.domainEventBus.publish({
          type: 'manuscript.nodes.deleted',
          projectId: docProjectId,
          deletedDocIds: [doc.id],
          deletedFileIds: [],
          hadRootDoc: deletedRootDoc,
          occurredAt: Date.now(),
        });

        this.eventEmitter?.emit('pages.file-tree.change', {
          projectId: docProjectId,
          change: {
            action: 'delete',
            node: { id: pageId, docId: doc.id },
          },
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Soft-delete fallback for target ${pageId}: ${msg}`);
    }
    return { success: true };
  }

  public async getDeletedFiles(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    return getDeletedFilesInSpace(this.prisma, pageId, authorizedProjectId);
  }

  public async getTrashPages(spaceId: string) {
    return getTrashPagesInSpace(this.prisma, spaceId);
  }

  public async restorePage(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    if (!isUuid(pageId)) {
      throw new BadRequestException('A valid UUID is required for pageId');
    }
    const targetProjectId = resolveActiveProjectId(authorizedProjectId);
    return restoreDeletedDocOrFile(
      this.prisma,
      this.docstoreService,
      this.eventEmitter,
      pageId,
      targetProjectId,
    );
  }

  public async purgePagePermanently(
    pageId: string,
    authorizedProjectId?: string | { id: string } | null,
  ) {
    return purgePagePermanentlyInSpace(
      this.prisma,
      this.domainEventBus,
      this.eventEmitter,
      pageId,
      authorizedProjectId,
    );
  }
}

async function getDeletedFilesInSpace(
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

async function restoreDeletedDocOrFile(
  prisma: PrismaService,
  docstoreService: DocstoreService,
  eventEmitter: EventEmitter2 | undefined,
  pageId: string,
  targetProjectId?: string,
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

async function getTrashPagesInSpace(
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

async function purgePagePermanentlyInSpace(
  prisma: PrismaService,
  domainEventBus: PageDomainEventBus,
  eventEmitter: EventEmitter2 | undefined,
  pageId: string,
  authorizedProjectId?: string | { id: string } | null,
) {
  if (!isUuid(pageId)) {
    throw new NotFoundException(`Page ${pageId} not found`);
  }
  const targetProjectId = resolveActiveProjectId(authorizedProjectId);
  const pageRow = await prisma.page.findUnique({
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
    prisma.pageFile.findMany({
      where: { pageId: pageRow.id, spaceId },
      select: { id: true, sizeBytes: true, blobId: true, hash: true },
    }),
    prisma.pageDoc.findMany({
      where: { pageId: pageRow.id, spaceId },
      select: { id: true, inStorage: true, storageKey: true },
    }),
  ]);

  // Evict live Yjs collaboration sessions before hard-deleting docs
  if (pageDocs.length > 0) {
    await domainEventBus.publish({
      type: 'manuscript.nodes.deleted',
      projectId: spaceId,
      deletedDocIds: pageDocs.map((d) => d.id),
      deletedFileIds: pageFiles.map((f) => f.id),
      hadRootDoc: true,
      occurredAt: Date.now(),
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.pageLabel.deleteMany({ where: { pageId: pageRow.id } });
    await tx.pageNode.deleteMany({ where: { pageId: pageRow.id, spaceId } });
    await tx.pageFile.deleteMany({ where: { pageId: pageRow.id, spaceId } });
    await tx.pageDoc.deleteMany({ where: { pageId: pageRow.id, spaceId } });
    await tx.page.delete({ where: { id: pageRow.id } });
  });

  // Reclaim CAS blob ref-counts, cold-tier S3 doc objects, and storage quota only on permanent purge
  eventEmitter?.emit('pages.page.deleted', {
    projectId: spaceId,
    pageId: pageRow.id,
    deletedFiles: pageFiles,
    deletedDocs: pageDocs,
  });

  return { success: true, purgedPageId: pageRow.id };
}
