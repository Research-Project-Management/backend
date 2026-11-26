/**
 * modules/pages/export-import/adapters/hydrator.adapter.ts
 *
 * GoF Adapter + Builder (`ImportSummaryBuilder`) + Cohesive Node Hydration Strategies:
 * Hydrates extracted `ArchiveEntryVo` entries into virtual file tree (`StructureService`),
 * `DocstoreService` text lines, and `FilestoreService` binary objects.
 */

import { Injectable, Optional, Inject } from '@nestjs/common';
import * as path from 'node:path';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  PageDomainEventBus,
} from '@/modules/pages/core';
import {
  ArchiveEntryVo,
  ImportSummaryBuilder,
  ImportSummaryVo,
} from '../domain/archive.domain';
import { IPageArchiveHydratorPort } from '../domain/archive.ports';
import { StructureService } from '@/modules/pages/structure/structure.service';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { FilestoreService } from '@/modules/pages/filestore/filestore.service';
import type { PageNodeEntity } from '@/modules/pages/structure/domain';

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

interface HydrationSession {
  projectId: string;
  pageId?: string;
  createdDirs: Set<string>;
  nodesByPath: Map<string, PageNodeEntity> | null;
  builder: ImportSummaryBuilder;
}

@Injectable()
export class PageArchiveHydratorAdapter extends IPageArchiveHydratorPort {
  constructor(
    private readonly structureService: StructureService,
    private readonly docstoreService: DocstoreService,
    private readonly filestoreService: FilestoreService,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    private readonly liveCollab?: LiveCollaborationPort,
    @Optional()
    private readonly domainEventBus?: PageDomainEventBus,
  ) {
    super();
  }

  public async hydrateProjectEntries(
    projectId: string,
    entries: ArchiveEntryVo[],
    _userId?: string | null,
    preferredRootDoc?: string,
    pageId?: string,
  ): Promise<ImportSummaryVo> {
    await this.liveCollab?.flushDocs(projectId, []).catch(() => []);

    const session = await this.openHydrationSession(
      projectId,
      entries.length,
      pageId,
    );
    const wrapperPrefix = this.detectSingleWrapperFolder(entries);

    for (const entry of entries) {
      const cleanRelPath = this.stripWrapperPrefix(entry.path, wrapperPrefix);
      if (!cleanRelPath) continue;

      const normalizedPath = '/' + cleanRelPath;
      const parentDir = path.posix.dirname(normalizedPath);
      const baseName = path.posix.basename(normalizedPath);
      if (!baseName) continue;

      if (parentDir !== '/' && parentDir !== '.') {
        await this.ensureDirectoryHierarchy(session, parentDir);
      }

      if (entry.isDirectory) {
        await this.ensureDirectoryHierarchy(session, normalizedPath);
        session.builder.recordFolder();
        continue;
      }

      const existingNode = await this.resolveExistingNodeByPath(
        session,
        normalizedPath,
      );

      if (entry.getStorageType() === 'doc') {
        await this.hydrateDocEntry(
          session,
          entry,
          normalizedPath,
          baseName,
          existingNode,
        );
      } else {
        await this.hydrateFileEntry(
          session,
          entry,
          cleanRelPath,
          normalizedPath,
          baseName,
          existingNode,
        );
      }
    }

    await this.resolveAndConfigureRootDoc(
      session,
      preferredRootDoc,
      wrapperPrefix,
    );

    return session.builder.build();
  }

  private async openHydrationSession(
    projectId: string,
    totalEntries: number,
    pageId?: string,
  ): Promise<HydrationSession> {
    const createdDirs = new Set<string>(['/']);
    let nodesByPath: Map<string, PageNodeEntity> | null = null;

    if (typeof this.structureService.getAllNodes === 'function') {
      try {
        const allNodes = pageId
          ? await this.structureService.getAllNodes(projectId, undefined, pageId)
          : await this.structureService.getAllNodes(projectId);
        if (Array.isArray(allNodes) && allNodes.length > 0) {
          nodesByPath = new Map();
          for (const n of allNodes) {
            if (n?.path) {
              nodesByPath.set(n.path, n);
              if (n.type === 'FOLDER') createdDirs.add(n.path);
            }
          }
        }
      } catch {
        nodesByPath = null;
      }
    }

    return {
      projectId,
      pageId,
      createdDirs,
      nodesByPath,
      builder: new ImportSummaryBuilder(projectId, totalEntries),
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
      session.builder.recordDoc(existingNode.docId, lines);
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
    session.builder.recordDoc(doc._id, lines);
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
          const recheck = await this.resolveExistingNodeByPath(
            session,
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
      session.builder.recordFile();
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

    const alreadyCreated =
      (session.pageId
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
        : null);

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

    session.builder.recordFile();
  }

  private async resolveAndConfigureRootDoc(
    session: HydrationSession,
    preferredRootDoc?: string,
    wrapperPrefix?: string | null,
  ): Promise<void> {
    let rootDocId: string | null = null;
    let rootDocPath: string | null = null;

    if (preferredRootDoc) {
      const cleanPreferred = this.stripWrapperPrefix(
        preferredRootDoc,
        wrapperPrefix ?? null,
      );
      if (cleanPreferred) {
        const preferredNorm = '/' + cleanPreferred;
        const match = session.pageId
          ? await this.structureService.getNodeByPath(
              session.projectId,
              preferredNorm,
              session.pageId,
            )
          : await this.structureService.getNodeByPath(
              session.projectId,
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
      const docContentsMap = session.builder.getDocContentsMap();
      const detected = session.pageId
        ? await this.structureService.autoDetectRootDoc(
            session.projectId,
            docContentsMap,
            undefined,
            session.pageId,
          )
        : await this.structureService.autoDetectRootDoc(
            session.projectId,
            docContentsMap,
          );

      if (detected) {
        rootDocId = detected.docId || detected.id;
        rootDocPath = detected.path;
      }
    }

    session.builder.withRootDoc(rootDocId, rootDocPath);

    if (!rootDocId) return;
    const rootLines = session.builder.getDocLines(rootDocId);
    if (!rootLines) return;

    const titleMatch = rootLines
      .join('\n')
      .match(/\\title\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/);
    if (!titleMatch?.[1]) return;

    const cleanTitle = titleMatch[1]
      .replace(/\\[a-zA-Z]+(?:\*|\b)?/g, '')
      .replace(/[{}]/g, '')
      .trim();
    if (!cleanTitle) return;

    const current = await this.docstoreService
      .getDoc(session.projectId, rootDocId)
      .catch(() => null);
    if (!current) return;

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

  private detectSingleWrapperFolder(entries: ArchiveEntryVo[]): string | null {
    const fileEntries = entries.filter((e) => !e.isDirectory);
    if (fileEntries.length === 0) return null;

    let commonTopFolder: string | null = null;
    let hasRootTexInsideWrapper = false;

    for (const entry of entries) {
      const clean = entry.path.replace(/^\/+/, '').replace(/\/+$/, '');
      if (!clean) continue;
      const segments = clean.split('/');
      const firstSegment = segments[0];

      if (commonTopFolder === null) {
        commonTopFolder = firstSegment;
      } else if (commonTopFolder !== firstSegment) {
        return null;
      }

      if (!entry.isDirectory) {
        if (segments.length < 2) return null;
        if (
          segments.length === 2 &&
          /\.(tex|ltx|rtex|latex)$/i.test(segments[1])
        ) {
          hasRootTexInsideWrapper = true;
        }
      }
    }

    return hasRootTexInsideWrapper ? commonTopFolder : null;
  }
}
