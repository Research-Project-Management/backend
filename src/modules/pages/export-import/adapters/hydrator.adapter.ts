import { Injectable, Optional, Inject } from '@nestjs/common';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { PrismaService, isUuid, mapWithConcurrency } from '@/core';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  PageDomainEventBus,
} from '@/modules/pages/core';
import { DocstoreService } from '@/modules/pages/docstore';
import { FilestoreService } from '@/modules/pages/filestore';
import {
  StructureService,
  type PageNodeEntity,
} from '@/modules/pages/structure';
import { ArchiveEntryVo, ImportSummaryVo } from '../domain/archive.domain';
import type { HydrateProjectOptions } from '../types/archive.types';

const HYDRATE_CONCURRENCY = 6;
const WRAPPER_ROOT_TEX_RE = /\.(tex|ltx|rtex|latex)$/i;

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.eps': 'application/postscript',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function inferMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

function countPathDepth(posixPath: string): number {
  let depth = 0;
  for (let i = 0; i < posixPath.length; i++) {
    if (posixPath.charCodeAt(i) === 47) depth++;
  }
  return depth;
}

function extractLatexTitle(rawText: string): string | null {
  const match = rawText.match(/\\title\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/);
  if (!match?.[1]) return null;
  const clean = match[1]
    .replace(/\\([_&%#$])/g, '$1')
    .replace(/\\[a-zA-Z]+(?:\*|\b)?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || null;
}

interface PreparedFileTask {
  entry: ArchiveEntryVo;
  cleanRelPath: string;
  normalizedPath: string;
  baseName: string;
}

interface HydrationSession {
  projectId: string;
  pageId?: string;
  isNewPage: boolean;
  preferredRootNormalizedPath: string | null;
  prefetched: boolean;
  createdDirs: Set<string>;
  nodesByPath: Map<string, PageNodeEntity> | null;
  docContents: Map<string, string[]>;
  totalDocs: number;
  totalFiles: number;
  totalFolders: number;
}

@Injectable()
export class PageArchiveHydratorAdapter {
  constructor(
    private readonly structureService: StructureService,
    private readonly docstoreService: DocstoreService,
    private readonly filestoreService: FilestoreService,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    private readonly liveCollab?: LiveCollaborationPort,
    @Optional()
    private readonly domainEventBus?: PageDomainEventBus,
    @Optional()
    private readonly prisma?: PrismaService,
  ) {}

  /**
   * 3-Phase Topological Hydration Pipeline:
   * - Phase 1 (O(N) in-memory): Strip wrapper folder, deduplicate colliding entry paths (last-wins),
   *   and prune ancestor directories so `mkdirp` only runs on deepest leaf directories.
   * - Phase 2 (Bounded Concurrency = 6): Hydrate disjoint doc & binary file entries in parallel.
   * - Phase 3: Resolve and configure root LaTeX document.
   */
  public async hydrateProjectEntries(
    projectId: string,
    entries: ArchiveEntryVo[],
    userId?: string | null,
    preferredRootDocOrOptions?: string | HydrateProjectOptions,
    pageId?: string,
  ): Promise<ImportSummaryVo> {
    const options: HydrateProjectOptions =
      typeof preferredRootDocOrOptions === 'string'
        ? { preferredRootDoc: preferredRootDocOrOptions }
        : (preferredRootDocOrOptions ?? {});
    const preferredRootDoc = options.preferredRootDoc;

    const canonicalSpaceId =
      (!projectId || projectId.trim().toLowerCase() === 'personal') &&
      userId &&
      isUuid(userId)
        ? userId
        : projectId;

    const explicitPageId = pageId?.trim() || undefined;
    const shouldCreateNewPage =
      !explicitPageId && Boolean(options.createNewPage || this.prisma?.page);
    const effectivePageId =
      explicitPageId || (shouldCreateNewPage ? crypto.randomUUID() : undefined);

    await this.liveCollab?.flushDocs(canonicalSpaceId, []).catch(() => []);

    const wrapperPrefix = this.detectSingleWrapperFolder(entries);

    const requiredDirs = new Set<string>();
    const explicitDirs = new Set<string>();
    const uniqueTasksByPath = new Map<string, PreparedFileTask>();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const cleanRelPath = this.stripWrapperPrefix(entry.path, wrapperPrefix);
      if (!cleanRelPath) continue;

      const normalizedPath = '/' + cleanRelPath;
      const parentDir = path.posix.dirname(normalizedPath);
      const baseName = path.posix.basename(normalizedPath);
      if (!baseName) continue;

      if (parentDir !== '/' && parentDir !== '.') {
        requiredDirs.add(parentDir);
      }

      if (entry.isDirectory) {
        requiredDirs.add(normalizedPath);
        explicitDirs.add(normalizedPath);
        continue;
      }

      uniqueTasksByPath.set(normalizedPath, {
        entry,
        cleanRelPath,
        normalizedPath,
        baseName,
      });
    }

    const fileTasks = Array.from(uniqueTasksByPath.values());
    const cleanPreferredRoot = preferredRootDoc
      ? this.stripWrapperPrefix(preferredRootDoc, wrapperPrefix)
      : null;
    const candidateRootTask = this.selectCandidateRootTexTask(
      fileTasks,
      cleanPreferredRoot ? '/' + cleanPreferredRoot : null,
    );
    const preExtractedTitle = candidateRootTask
      ? extractLatexTitle(candidateRootTask.entry.data.toString('utf8'))
      : null;
    const initialTitle =
      preExtractedTitle || options.defaultTitle?.trim() || 'Untitled';

    if (shouldCreateNewPage && effectivePageId) {
      await this.provisionNewPageAggregate(
        canonicalSpaceId,
        effectivePageId,
        initialTitle,
        userId,
      );
    }

    const session = await this.openHydrationSession(
      canonicalSpaceId,
      effectivePageId,
      shouldCreateNewPage,
      candidateRootTask?.normalizedPath ?? null,
    );
    session.totalFolders = explicitDirs.size;

    if (
      options.overwrite &&
      effectivePageId &&
      session.prefetched &&
      session.nodesByPath
    ) {
      await this.pruneOverwrittenPageNodes(
        session,
        uniqueTasksByPath,
        requiredDirs,
      );
    }

    // Phase 1: Pruned Leaf-First Directory Creation (deepest dirs mark all ancestors in O(depth))
    const sortedDirs = Array.from(requiredDirs).sort(
      (a, b) => countPathDepth(b) - countPathDepth(a),
    );
    for (let i = 0; i < sortedDirs.length; i++) {
      await this.ensureDirectoryHierarchy(session, sortedDirs[i]);
    }

    // Phase 2: Bounded Parallel File & Document Hydration
    await mapWithConcurrency<PreparedFileTask, void>(
      fileTasks,
      HYDRATE_CONCURRENCY,
      async (task) => {
        const existingNode = await this.resolveExistingNodeByPath(
          session,
          task.normalizedPath,
        );

        if (task.entry.getStorageType() === 'doc') {
          await this.hydrateDocEntry(
            session,
            task.entry,
            task.normalizedPath,
            task.baseName,
            existingNode,
          );
        } else {
          await this.hydrateFileEntry(
            session,
            task.entry,
            task.cleanRelPath,
            task.normalizedPath,
            task.baseName,
            existingNode,
          );
        }
      },
    );

    // Phase 3: Root Document Configuration
    const { rootDocId, rootDocPath, extractedTitle } =
      await this.resolveAndConfigureRootDoc(
        session,
        preferredRootDoc,
        wrapperPrefix,
      );

    const firstHydratedDocId =
      session.docContents.keys().next().value ?? null;
    const resolvedRootDocId =
      rootDocId || firstHydratedDocId || effectivePageId || canonicalSpaceId;

    const finalTitle = await this.finalizePageAggregateMetadata({
      spaceId: canonicalSpaceId,
      pageId: effectivePageId,
      isNewPage: shouldCreateNewPage,
      rootDocId: rootDocId || firstHydratedDocId,
      extractedTitle: extractedTitle || preExtractedTitle,
      defaultTitle: options.defaultTitle,
    });

    return new ImportSummaryVo({
      pageId: effectivePageId || resolvedRootDocId,
      projectId: canonicalSpaceId,
      totalEntries: entries.length,
      totalDocs: session.totalDocs,
      totalFiles: session.totalFiles,
      totalFolders: session.totalFolders,
      rootDocId: resolvedRootDocId,
      rootDocPath,
      title: finalTitle,
      skippedFiles: options.skippedFiles ?? [],
    });
  }

  private selectCandidateRootTexTask(
    tasks: PreparedFileTask[],
    preferredNormalizedPath: string | null,
  ): PreparedFileTask | null {
    if (preferredNormalizedPath) {
      const exact = tasks.find(
        (t) =>
          t.normalizedPath === preferredNormalizedPath &&
          t.entry.getStorageType() === 'doc',
      );
      if (exact) return exact;
    }

    const mainTex = tasks.find(
      (t) =>
        t.normalizedPath.toLowerCase() === '/main.tex' &&
        t.entry.getStorageType() === 'doc',
    );
    if (mainTex) return mainTex;

    const texTasks = tasks.filter(
      (t) =>
        WRAPPER_ROOT_TEX_RE.test(t.baseName) &&
        t.entry.getStorageType() === 'doc',
    );
    for (const candidate of texTasks) {
      if (candidate.entry.data.toString('utf8').includes('\\documentclass')) {
        return candidate;
      }
    }
    return texTasks[0] ?? null;
  }

  private async provisionNewPageAggregate(
    spaceId: string,
    pageId: string,
    title: string,
    userId?: string | null,
  ): Promise<void> {
    if (!this.prisma) return;

    const isPersonalSpace =
      isUuid(spaceId) &&
      Boolean(userId && spaceId.toLowerCase() === userId.toLowerCase());

    if (isPersonalSpace && this.prisma.space?.upsert && userId) {
      await Promise.resolve(
        this.prisma.space.upsert({
          where: { id: spaceId },
          create: {
            id: spaceId,
            type: 'personal',
            ownerUserId: userId,
          },
          update: {},
        }),
      ).catch(() => null);
    } else if (
      !userId &&
      isUuid(spaceId) &&
      this.prisma.space?.findUnique &&
      this.prisma.space?.upsert &&
      this.prisma.user?.findUnique
    ) {
      const existingSpace = await Promise.resolve(
        this.prisma.space.findUnique({
          where: { id: spaceId },
          select: { id: true },
        }),
      ).catch(() => null);
      if (!existingSpace) {
        const ownerUser = await Promise.resolve(
          this.prisma.user.findUnique({
            where: { id: spaceId },
            select: { id: true },
          }),
        ).catch(() => null);
        if (ownerUser?.id) {
          await Promise.resolve(
            this.prisma.space.upsert({
              where: { id: spaceId },
              create: {
                id: spaceId,
                type: 'personal',
                ownerUserId: ownerUser.id,
              },
              update: {},
            }),
          ).catch(() => null);
        }
      }
    }

    const pageData = {
      id: pageId,
      spaceId,
      rootDocId: null,
      title: title.slice(0, 500),
      status: 'draft' as const,
      compiler: 'pdflatex',
      texlive: '2025',
      spellLang: 'en_US',
      createdById: userId && isUuid(userId) ? userId : null,
    };

    if (this.prisma.page?.create) {
      await Promise.resolve(
        this.prisma.page.create({
          data: pageData,
        }),
      );
    } else if (this.prisma.page?.upsert) {
      await Promise.resolve(
        this.prisma.page.upsert({
          where: { id: pageId },
          create: pageData,
          update: { title: pageData.title },
        }),
      );
    }
  }

  private async finalizePageAggregateMetadata(params: {
    spaceId: string;
    pageId?: string;
    isNewPage: boolean;
    rootDocId: string | null;
    extractedTitle: string | null;
    defaultTitle?: string;
  }): Promise<string> {
    const { spaceId, pageId, isNewPage, rootDocId, extractedTitle } = params;
    const cleanDefault = params.defaultTitle?.trim() || undefined;

    if (!pageId || !this.prisma?.page) {
      return extractedTitle || cleanDefault || 'Untitled';
    }

    if (isNewPage) {
      const finalTitle = (extractedTitle || cleanDefault || 'Untitled').slice(
        0,
        500,
      );
      const updateData: { rootDocId?: string; title: string } = {
        title: finalTitle,
      };
      if (rootDocId && isUuid(rootDocId)) {
        updateData.rootDocId = rootDocId;
      }
      if (this.prisma.page.update) {
        await Promise.resolve(
          this.prisma.page.update({
            where: { id: pageId },
            data: updateData,
          }),
        ).catch(() => null);
      } else if (this.prisma.page.updateMany) {
        await Promise.resolve(
          this.prisma.page.updateMany({
            where: { id: pageId, spaceId },
            data: updateData,
          }),
        ).catch(() => null);
      }
      return finalTitle;
    }

    let existingTitle: string | undefined;
    if (this.prisma.page.findUnique) {
      const existingPage = await Promise.resolve(
        this.prisma.page.findUnique({
          where: { id: pageId },
          select: { title: true },
        }),
      ).catch(() => null);
      existingTitle = existingPage?.title?.trim() || undefined;
    }

    if (rootDocId && isUuid(rootDocId) && this.prisma.page.updateMany) {
      await Promise.resolve(
        this.prisma.page.updateMany({
          where: { id: pageId, spaceId, deletedAt: null },
          data: { rootDocId },
        }),
      ).catch(() => null);
    }

    return existingTitle || extractedTitle || cleanDefault || 'Untitled';
  }

  private async pruneOverwrittenPageNodes(
    session: HydrationSession,
    incomingTasks: Map<string, PreparedFileTask>,
    requiredDirs: Set<string>,
  ): Promise<void> {
    if (!session.nodesByPath) return;

    const existingEntries = Array.from(session.nodesByPath.entries());
    for (const [nodePath, node] of existingEntries) {
      if (node.type !== 'FOLDER' && !incomingTasks.has(nodePath)) {
        await this.removeConflictingNode(session, node, nodePath);
      }
    }

    const staleFolders = existingEntries
      .filter(
        ([dirPath, node]) =>
          node.type === 'FOLDER' &&
          dirPath !== '/' &&
          !requiredDirs.has(dirPath) &&
          !Array.from(requiredDirs).some((req) => req.startsWith(dirPath + '/')),
      )
      .sort((a, b) => countPathDepth(b[0]) - countPathDepth(a[0]));

    for (const [dirPath, folderNode] of staleFolders) {
      await this.structureService
        .deleteNode(session.projectId, folderNode.id)
        .catch(() => undefined);
      session.nodesByPath.delete(dirPath);
      session.createdDirs.delete(dirPath);
    }
  }

  private async openHydrationSession(
    projectId: string,
    pageId?: string,
    isNewPage = false,
    preferredRootNormalizedPath: string | null = null,
  ): Promise<HydrationSession> {
    const createdDirs = new Set<string>(['/']);
    let nodesByPath: Map<string, PageNodeEntity> | null = null;
    let prefetched = false;

    if (isNewPage) {
      prefetched = true;
      nodesByPath = new Map();
    } else if (typeof this.structureService.getAllNodes === 'function') {
      try {
        const allNodes = pageId
          ? await this.structureService.getAllNodes(
              projectId,
              undefined,
              pageId,
            )
          : await this.structureService.getAllNodes(projectId);
        if (Array.isArray(allNodes)) {
          prefetched = true;
          nodesByPath = new Map();
          for (let i = 0; i < allNodes.length; i++) {
            const n = allNodes[i];
            if (n?.path) {
              nodesByPath.set(n.path, n);
              if (n.type === 'FOLDER') createdDirs.add(n.path);
            }
          }
        }
      } catch {
        nodesByPath = null;
        prefetched = false;
      }
    }

    return {
      projectId,
      pageId,
      isNewPage,
      preferredRootNormalizedPath,
      prefetched,
      createdDirs,
      nodesByPath,
      docContents: new Map(),
      totalDocs: 0,
      totalFiles: 0,
      totalFolders: 0,
    };
  }

  private stripWrapperPrefix(
    rawPath: string,
    wrapperPrefix: string | null,
  ): string | null {
    const cleanRelPath = rawPath.replace(/^\/+/, '');
    if (!wrapperPrefix) return cleanRelPath;
    if (cleanRelPath === wrapperPrefix) return null;
    if (cleanRelPath.startsWith(wrapperPrefix + '/')) {
      return cleanRelPath.slice(wrapperPrefix.length + 1);
    }
    return cleanRelPath;
  }

  private async ensureDirectoryHierarchy(
    session: HydrationSession,
    dirPath: string,
  ): Promise<void> {
    if (session.createdDirs.has(dirPath)) return;
    if (session.pageId) {
      await this.structureService.mkdirp(
        session.projectId,
        dirPath,
        session.pageId,
      );
    } else {
      await this.structureService.mkdirp(session.projectId, dirPath);
    }
    let cur = dirPath;
    while (cur && cur !== '/' && cur !== '.') {
      session.createdDirs.add(cur);
      cur = path.posix.dirname(cur);
    }
  }

  private async resolveExistingNodeByPath(
    session: HydrationSession,
    normalizedPath: string,
  ): Promise<PageNodeEntity | null> {
    if (session.prefetched && session.nodesByPath) {
      return session.nodesByPath.get(normalizedPath) ?? null;
    }
    if (session.nodesByPath?.has(normalizedPath)) {
      return session.nodesByPath.get(normalizedPath) ?? null;
    }
    return session.pageId
      ? this.structureService.getNodeByPath(
          session.projectId,
          normalizedPath,
          session.pageId,
        )
      : this.structureService.getNodeByPath(session.projectId, normalizedPath);
  }

  private async removeConflictingNode(
    session: HydrationSession,
    existingNode: PageNodeEntity,
    normalizedPath: string,
  ): Promise<void> {
    if (existingNode.fileId) {
      await this.filestoreService
        .deleteFile?.(session.projectId, existingNode.fileId, true)
        .catch(() => undefined);
    }
    await this.structureService
      .deleteNode(session.projectId, existingNode.id)
      .catch(() => undefined);
    session.nodesByPath?.delete(normalizedPath);
  }

  private async publishDocMutation(
    projectId: string,
    docId: string,
    lines: string[],
    version: number,
    fallbackApplyCollab = false,
  ): Promise<void> {
    if (this.domainEventBus) {
      await this.domainEventBus.publish({
        type: 'manuscript.document.mutated',
        projectId,
        docId,
        lines,
        version,
        source: 'template-hydration',
        occurredAt: Date.now(),
      });
    } else if (fallbackApplyCollab) {
      await this.liveCollab
        ?.applyExternalText(projectId, docId, lines.join('\n'))
        .catch(() => {});
    }
  }

  private async hydrateDocEntry(
    session: HydrationSession,
    entry: ArchiveEntryVo,
    normalizedPath: string,
    baseName: string,
    existingNode: PageNodeEntity | null,
  ): Promise<void> {
    const text = entry.data.toString('utf8').replace(/^\uFEFF/, '');
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

    if (existingNode && existingNode.type === 'DOC' && existingNode.docId) {
      const current = await this.docstoreService
        .getDoc(session.projectId, existingNode.docId)
        .catch(() => null);
      const nextVersion = (current?.version ?? 0) + 1;
      await this.docstoreService.updateDoc(
        session.projectId,
        existingNode.docId,
        { lines, version: nextVersion },
      );
      await this.publishDocMutation(
        session.projectId,
        existingNode.docId,
        lines,
        nextVersion,
        true,
      );
      session.docContents.set(existingNode.docId, lines);
      session.totalDocs += 1;
      return;
    }

    if (existingNode) {
      await this.removeConflictingNode(session, existingNode, normalizedPath);
    }

    const assignPageIdToRootDoc =
      session.isNewPage &&
      Boolean(session.pageId && isUuid(session.pageId)) &&
      session.preferredRootNormalizedPath === normalizedPath;

    const doc = await this.docstoreService.createDoc(session.projectId, {
      ...(assignPageIdToRootDoc ? { id: session.pageId } : {}),
      path: normalizedPath,
      lines,
      ...(session.pageId ? { pageId: session.pageId } : {}),
    });

    const createdDocNode = session.pageId
      ? await this.structureService.createNode(
          session.projectId,
          {
            path: normalizedPath,
            name: baseName,
            type: 'DOC',
            docId: doc._id,
            pageId: session.pageId,
          },
          session.pageId,
        )
      : await this.structureService.createNode(session.projectId, {
          path: normalizedPath,
          name: baseName,
          type: 'DOC',
          docId: doc._id,
        });

    if (createdDocNode && session.nodesByPath) {
      session.nodesByPath.set(normalizedPath, createdDocNode);
    }

    await this.publishDocMutation(
      session.projectId,
      doc._id,
      lines,
      doc.version ?? 1,
    );
    session.docContents.set(doc._id, lines);
    session.totalDocs += 1;
  }

  private async hydrateFileEntry(
    session: HydrationSession,
    entry: ArchiveEntryVo,
    cleanRelPath: string,
    normalizedPath: string,
    baseName: string,
    existingNode: PageNodeEntity | null,
  ): Promise<void> {
    const mimeType = inferMimeType(entry.path);
    const uploadTargetName = cleanRelPath || baseName;

    if (existingNode && existingNode.type === 'FILE') {
      const previousFileId = existingNode.fileId;
      const file = session.pageId
        ? await this.filestoreService.uploadFileFromBuffer(
            session.projectId,
            uploadTargetName,
            entry.data,
            mimeType,
            { pageId: session.pageId, syncStructureNode: false },
          )
        : await this.filestoreService.uploadFileFromBuffer(
            session.projectId,
            uploadTargetName,
            entry.data,
            mimeType,
            { syncStructureNode: false },
          );

      const fileHash = file.hash?.getValue() ?? String(file.hash);
      await this.structureService
        .updateNodeFileId(
          session.projectId,
          existingNode.id,
          file.id,
          entry.data.length,
          fileHash,
        )
        .catch(async () => {
          const recheck = session.pageId
            ? await this.structureService.getNodeByPath(
                session.projectId,
                normalizedPath,
                session.pageId,
              )
            : await this.structureService.getNodeByPath(
                session.projectId,
                normalizedPath,
              );
          if (recheck) {
            await this.structureService.updateNodeFileId(
              session.projectId,
              recheck.id,
              file.id,
              entry.data.length,
              fileHash,
            );
          }
        });

      if (previousFileId && previousFileId !== file.id) {
        await this.filestoreService
          .deleteFile?.(session.projectId, previousFileId, true)
          .catch(() => undefined);
      }
      session.totalFiles += 1;
      return;
    }

    if (existingNode) {
      await this.removeConflictingNode(session, existingNode, normalizedPath);
    }

    const file = session.pageId
      ? await this.filestoreService.uploadFileFromBuffer(
          session.projectId,
          uploadTargetName,
          entry.data,
          mimeType,
          { pageId: session.pageId, syncStructureNode: false },
        )
      : await this.filestoreService.uploadFileFromBuffer(
          session.projectId,
          uploadTargetName,
          entry.data,
          mimeType,
          { syncStructureNode: false },
        );

    // Only check for auto-created node when uploadFileFromBuffer may have written directly
    // AND nodes were not prefetched clean.
    const alreadyCreated = session.prefetched
      ? null
      : ((session.pageId
          ? await this.structureService.getNodeByPath(
              session.projectId,
              normalizedPath,
              session.pageId,
            )
          : await this.structureService.getNodeByPath(
              session.projectId,
              normalizedPath,
            )) ??
        (file?.id
          ? await this.structureService
              .getNodeById(session.projectId, file.id)
              .catch(() => null)
          : null));

    if (!alreadyCreated) {
      const createdFileNode = await (
        session.pageId
          ? this.structureService.createNode(
              session.projectId,
              {
                path: normalizedPath,
                name: baseName,
                type: 'FILE',
                fileId: file.id,
                pageId: session.pageId,
              },
              session.pageId,
            )
          : this.structureService.createNode(session.projectId, {
              path: normalizedPath,
              name: baseName,
              type: 'FILE',
              fileId: file.id,
            })
      ).catch(() => undefined);
      if (createdFileNode && session.nodesByPath) {
        session.nodesByPath.set(normalizedPath, createdFileNode);
      }
    } else if (session.nodesByPath) {
      session.nodesByPath.set(normalizedPath, alreadyCreated);
    }

    session.totalFiles += 1;
  }

  private async resolveAndConfigureRootDoc(
    session: HydrationSession,
    preferredRootDoc?: string,
    wrapperPrefix?: string | null,
  ): Promise<{
    rootDocId: string | null;
    rootDocPath: string | null;
    extractedTitle: string | null;
  }> {
    let rootDocId: string | null = null;
    let rootDocPath: string | null = null;
    let extractedTitle: string | null = null;

    if (preferredRootDoc) {
      const cleanPreferred = this.stripWrapperPrefix(
        preferredRootDoc,
        wrapperPrefix ?? null,
      );
      if (cleanPreferred) {
        const preferredNorm = '/' + cleanPreferred;
        const match = await this.resolveExistingNodeByPath(
          session,
          preferredNorm,
        );
        if (match && match.type === 'DOC') {
          const updated = await this.structureService.setRootDoc(
            session.projectId,
            match.id,
          );
          rootDocId = updated.docId || updated.id;
          rootDocPath = updated.path;
        }
      }
    }

    if (!rootDocId) {
      const detected = session.pageId
        ? await this.structureService.autoDetectRootDoc(
            session.projectId,
            session.docContents,
            undefined,
            session.pageId,
          )
        : await this.structureService.autoDetectRootDoc(
            session.projectId,
            session.docContents,
          );

      if (detected) {
        rootDocId = detected.docId || detected.id;
        rootDocPath = detected.path;
      }
    }

    if (rootDocId) {
      const rootLines = session.docContents.get(rootDocId);
      const cleanTitle = rootLines
        ? extractLatexTitle(rootLines.join('\n'))
        : null;
      if (rootLines && cleanTitle) {
        extractedTitle = cleanTitle;
        const current = await this.docstoreService
          .getDoc(session.projectId, rootDocId)
          .catch(() => null);
        if (current) {
          const currentRanges =
            current.ranges && typeof current.ranges === 'object'
              ? (current.ranges as Record<string, unknown>)
              : {};
          const nextVersion = (current.version ?? 0) + 1;
          await this.docstoreService
            .updateDoc(session.projectId, rootDocId, {
              lines: rootLines,
              version: nextVersion,
              ranges: { ...currentRanges, title: cleanTitle },
            })
            .catch(() => undefined);
          await this.publishDocMutation(
            session.projectId,
            rootDocId,
            rootLines,
            nextVersion,
          );
        }
      }
    }

    return { rootDocId, rootDocPath, extractedTitle };
  }

  private detectSingleWrapperFolder(entries: ArchiveEntryVo[]): string | null {
    let hasFile = false;
    let commonTopFolder: string | null = null;
    let hasRootTexInsideWrapper = false;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const clean = entry.path.replace(/^\/+/, '').replace(/\/+$/, '');
      if (!clean) continue;

      const firstSlash = clean.indexOf('/');
      const firstSegment =
        firstSlash === -1 ? clean : clean.slice(0, firstSlash);

      if (commonTopFolder === null) {
        commonTopFolder = firstSegment;
      } else if (commonTopFolder !== firstSegment) {
        return null;
      }

      if (!entry.isDirectory) {
        hasFile = true;
        if (firstSlash === -1) return null;
        const remainder = clean.slice(firstSlash + 1);
        if (!remainder.includes('/') && WRAPPER_ROOT_TEX_RE.test(remainder)) {
          hasRootTexInsideWrapper = true;
        }
      }
    }

    return hasFile && hasRootTexInsideWrapper ? commonTopFolder : null;
  }
}
