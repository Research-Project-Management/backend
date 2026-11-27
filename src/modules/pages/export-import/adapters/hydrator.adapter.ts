import { Injectable, Optional, Inject } from '@nestjs/common';
import * as path from 'node:path';
import { mapWithConcurrency } from '@/core';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  PageDomainEventBus,
} from '@/modules/pages/core';
import { ArchiveEntryVo, ImportSummaryVo } from '../domain/archive.domain';
import { StructureService } from '@/modules/pages/structure/structure.service';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { FilestoreService } from '@/modules/pages/filestore/filestore.service';
import type { PageNodeEntity } from '@/modules/pages/structure/domain';

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

interface PreparedFileTask {
  entry: ArchiveEntryVo;
  cleanRelPath: string;
  normalizedPath: string;
  baseName: string;
}

interface HydrationSession {
  projectId: string;
  pageId?: string;
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
    _userId?: string | null,
    preferredRootDoc?: string,
    pageId?: string,
  ): Promise<ImportSummaryVo> {
    await this.liveCollab?.flushDocs(projectId, []).catch(() => []);

    const session = await this.openHydrationSession(projectId, pageId);
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

    session.totalFolders = explicitDirs.size;

    // Phase 1: Pruned Leaf-First Directory Creation (deepest dirs mark all ancestors in O(depth))
    const sortedDirs = Array.from(requiredDirs).sort(
      (a, b) => countPathDepth(b) - countPathDepth(a),
    );
    for (let i = 0; i < sortedDirs.length; i++) {
      await this.ensureDirectoryHierarchy(session, sortedDirs[i]);
    }

    // Phase 2: Bounded Parallel File & Document Hydration
    const fileTasks = Array.from(uniqueTasksByPath.values());
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
    const { rootDocId, rootDocPath } = await this.resolveAndConfigureRootDoc(
      session,
      preferredRootDoc,
      wrapperPrefix,
    );

    return new ImportSummaryVo({
      projectId,
      totalEntries: entries.length,
      totalDocs: session.totalDocs,
      totalFiles: session.totalFiles,
      totalFolders: session.totalFolders,
      rootDocId,
      rootDocPath,
    });
  }

  private async openHydrationSession(
    projectId: string,
    pageId?: string,
  ): Promise<HydrationSession> {
    const createdDirs = new Set<string>(['/']);
    let nodesByPath: Map<string, PageNodeEntity> | null = null;
    let prefetched = false;

    if (typeof this.structureService.getAllNodes === 'function') {
      try {
        const allNodes = pageId
          ? await this.structureService.getAllNodes(projectId, undefined, pageId)
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

    const doc = await this.docstoreService.createDoc(session.projectId, {
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
            { pageId: session.pageId },
          )
        : await this.filestoreService.uploadFileFromBuffer(
            session.projectId,
            uploadTargetName,
            entry.data,
            mimeType,
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
          { pageId: session.pageId },
        )
      : await this.filestoreService.uploadFileFromBuffer(
          session.projectId,
          uploadTargetName,
          entry.data,
          mimeType,
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
      const createdFileNode = await (session.pageId
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
  ): Promise<{ rootDocId: string | null; rootDocPath: string | null }> {
    let rootDocId: string | null = null;
    let rootDocPath: string | null = null;

    if (preferredRootDoc) {
      const cleanPreferred = this.stripWrapperPrefix(
        preferredRootDoc,
        wrapperPrefix ?? null,
      );
      if (cleanPreferred) {
        const preferredNorm = '/' + cleanPreferred;
        const match = await this.resolveExistingNodeByPath(session, preferredNorm);
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
      const titleMatch = rootLines
        ?.join('\n')
        .match(/\\title\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/);
      if (rootLines && titleMatch?.[1]) {
        const cleanTitle = titleMatch[1]
          .replace(/\\[a-zA-Z]+(?:\*|\b)?/g, '')
          .replace(/[{}]/g, '')
          .trim();
        if (cleanTitle) {
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
    }

    return { rootDocId, rootDocPath };
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
      const firstSegment = firstSlash === -1 ? clean : clean.slice(0, firstSlash);

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
