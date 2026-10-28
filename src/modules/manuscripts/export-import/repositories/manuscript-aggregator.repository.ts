/**
 * modules/manuscripts/export-import/repositories/manuscript-aggregator.repository.ts
 * Repository collecting virtual file tree nodes, docstore text lines, and filestore
 * binary assets into a consolidated list for ZIP archiving, alongside project hydration
 * and embedded template catalog management.
 */

import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { mapWithConcurrency } from '@/core';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  ManuscriptDomainEventBus,
  ProjectWorkspaceCollectorService,
} from '@/modules/manuscripts/core';
import {
  IManuscriptAggregatorPort,
  ExportableFileEntry,
  IManuscriptHydratorPort,
  ArchiveEntryVo,
  ImportSummaryVo,
  isArxivAllowed,
} from '../domain';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { FilestoreService } from '@/modules/manuscripts/filestore/filestore.service';
import { ClsiService } from '@/modules/manuscripts/clsi';
import type { ManuscriptNodeEntity } from '@/modules/manuscripts/structure/domain';

const COLLECT_CONCURRENCY = 6;

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

@Injectable()
export class ManuscriptAggregatorAdapter extends IManuscriptAggregatorPort {
  private readonly logger = new Logger(ManuscriptAggregatorAdapter.name);

  constructor(
    private readonly structureService: StructureService,
    private readonly docstoreService: DocstoreService,
    private readonly filestoreService: FilestoreService,
    @Optional() private readonly clsiService?: ClsiService,
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    private readonly liveCollab?: LiveCollaborationPort,
    @Optional()
    private readonly workspaceCollector?: ProjectWorkspaceCollectorService,
  ) {
    super();
  }

  private async flushAndResolveCandidates(
    projectId: string,
    cleanArxiv: boolean,
  ): Promise<{
    nodes: ManuscriptNodeEntity[];
    candidates: Array<{ node: ManuscriptNodeEntity; relPath: string }>;
  }> {
    const nodes = await this.structureService.getAllNodes(projectId);
    const nonFolderNodes = nodes.filter((n) => n.type !== 'FOLDER');

    try {
      const docIds = nonFolderNodes
        .filter((n) => n.docId)
        .map((n) => n.docId as string);
      const collector =
        this.workspaceCollector ??
        this.moduleRef?.get(ProjectWorkspaceCollectorService, { strict: false });
      if (collector) {
        await collector.flushProjectWorkspace(projectId, docIds);
      } else {
        const live =
          this.liveCollab ??
          this.moduleRef?.get(LiveCollaborationPort, { strict: false });
        if (live && docIds.length > 0) {
          await live.flushDocs(projectId, docIds);
        }
      }
    } catch {
      // non-blocking fallback
    }

    const candidates = nonFolderNodes
      .map((node) => ({
        node,
        relPath: node.path.replace(/^\/+/, ''),
      }))
      .filter(
        ({ relPath }) => relPath && (!cleanArxiv || isArxivAllowed(relPath)),
      );

    return { nodes, candidates };
  }

  public async collectProjectEntries(
    projectId: string,
    includePdf = false,
    cleanArxiv = false,
  ): Promise<ExportableFileEntry[]> {
    const { nodes, candidates } = await this.flushAndResolveCandidates(
      projectId,
      cleanArxiv,
    );

    const results: ExportableFileEntry[] = [];

    const collected = await mapWithConcurrency<
      { node: ManuscriptNodeEntity; relPath: string },
      ExportableFileEntry | null
    >(
      candidates,
      COLLECT_CONCURRENCY,
      async ({
        node,
        relPath,
      }: {
        node: ManuscriptNodeEntity;
        relPath: string;
      }): Promise<ExportableFileEntry | null> => {
        try {
          if (node.type === 'DOC' && node.docId) {
            const doc = await this.docstoreService.getDoc(
              projectId,
              node.docId,
            );
            const textContent = (doc.lines || []).join('\n');
            return { path: relPath, data: Buffer.from(textContent, 'utf8') };
          }
          if (node.type === 'FILE' && node.fileId) {
            const streamResult = await this.filestoreService.openReadStream(
              projectId,
              node.fileId,
            );
            const buffer = await this.streamToBuffer(streamResult.stream);
            return { path: relPath, data: buffer };
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Failed to collect entry for node ${node.id} (${node.path}): ${errMsg}`,
          );
        }
        return null;
      },
    );
    for (const entry of collected) {
      if (entry) results.push(entry);
    }

    if (cleanArxiv && this.clsiService) {
      const hasBbl = results.some((r) => r.path.endsWith('.bbl'));
      if (!hasBbl) {
        try {
          const rootNode = nodes.find((n) => n.isRootDoc);
          const rootRelPath = rootNode
            ? rootNode.path.replace(/^\/+/, '')
            : null;
          const targetBblPath = rootRelPath
            ? rootRelPath.replace(/\.[^/.]+$/, '') + '.bbl'
            : 'output.bbl';

          const bblBuffer =
            (await this.clsiService.readAuxFileBuffer(
              projectId,
              targetBblPath,
            )) ||
            (await this.clsiService.readAuxFileBuffer(projectId, 'output.bbl'));

          if (bblBuffer && bblBuffer.length > 0) {
            results.push({
              path: targetBblPath,
              data: bblBuffer,
            });
          }
        } catch {
          // No bbl artifact available
        }
      }
    }

    if (includePdf && this.clsiService) {
      try {
        const buildArtifact = await this.clsiService.readAuxFileBuffer(
          projectId,
          'output.pdf',
        );
        if (buildArtifact) {
          results.push({
            path: 'output.pdf',
            data: buildArtifact,
          });
        }
      } catch {
        // PDF compilation artifact not available or never compiled; skip silently
      }
    }

    return results;
  }

  public async collectLazyProjectEntries(
    projectId: string,
    includePdf = false,
    cleanArxiv = false,
  ): Promise<ExportableFileEntry[]> {
    const { candidates } = await this.flushAndResolveCandidates(
      projectId,
      cleanArxiv,
    );

    const results: ExportableFileEntry[] = [];

    for (const { node, relPath } of candidates) {
      if (node.type === 'DOC' && node.docId) {
        const docId = node.docId;
        results.push({
          path: relPath,
          getData: async () => {
            const doc = await this.docstoreService.getDoc(projectId, docId);
            const textContent = (doc.lines || []).join('\n');
            return Buffer.from(textContent, 'utf8');
          },
        });
      } else if (node.type === 'FILE' && node.fileId) {
        const fileId = node.fileId;
        results.push({
          path: relPath,
          getData: async () => {
            const streamResult = await this.filestoreService.openReadStream(
              projectId,
              fileId,
            );
            return this.streamToBuffer(streamResult.stream);
          },
        });
      }
    }

    if (cleanArxiv && this.clsiService) {
      const hasBbl = results.some((r) => r.path.endsWith('.bbl'));
      if (!hasBbl) {
        const bblBuffer = await this.clsiService
          .readAuxFileBuffer(projectId, 'output.bbl')
          .catch(() => null);
        if (bblBuffer && bblBuffer.length > 0) {
          results.push({
            path: 'output.bbl',
            getData: async () => bblBuffer,
          });
        }
      }
    }

    if (includePdf && this.clsiService) {
      const pdfBuffer = await this.clsiService
        .readAuxFileBuffer(projectId, 'output.pdf')
        .catch(() => null);
      if (pdfBuffer && pdfBuffer.length > 0) {
        results.push({
          path: 'output.pdf',
          getData: async () => pdfBuffer,
        });
      }
    }

    return results;
  }

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      stream.on('data', (chunk) =>
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
      );
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', (err) => reject(err));
    });
  }
}

@Injectable()
export class ManuscriptHydratorAdapter extends IManuscriptHydratorPort {
  private readonly logger = new Logger(ManuscriptHydratorAdapter.name);

  constructor(
    private readonly structureService: StructureService,
    private readonly docstoreService: DocstoreService,
    private readonly filestoreService: FilestoreService,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    private readonly liveCollab?: LiveCollaborationPort,
    @Optional()
    private readonly domainEventBus?: ManuscriptDomainEventBus,
  ) {
    super();
  }

  public async hydrateProjectEntries(
    projectId: string,
    entries: ArchiveEntryVo[],
    userId?: string | null,
    preferredRootDoc?: string,
  ): Promise<ImportSummaryVo> {
    let totalDocs = 0;
    let totalFiles = 0;
    let totalFolders = 0;
    const docContentsMap = new Map<string, string[]>();

    try {
      await this.liveCollab?.flushDocs(projectId, []).catch(() => []);
    } catch {
      // non-blocking pre-hydration flush
    }

    const wrapperPrefix = this.detectSingleWrapperFolder(entries);
    const createdDirs = new Set<string>(['/']);

    for (const entry of entries) {
      let cleanRelPath = entry.path.replace(/^\/+/, '');
      if (wrapperPrefix) {
        if (cleanRelPath === wrapperPrefix) {
          continue;
        }
        if (cleanRelPath.startsWith(wrapperPrefix + '/')) {
          cleanRelPath = cleanRelPath.slice(wrapperPrefix.length + 1);
        }
      }
      const normalizedPath = '/' + cleanRelPath;
      const parentDir = path.posix.dirname(normalizedPath);
      const baseName = path.posix.basename(normalizedPath);

      if (!baseName) continue;

      if (parentDir !== '/' && parentDir !== '.' && !createdDirs.has(parentDir)) {
        await this.structureService.mkdirp(projectId, parentDir);
        createdDirs.add(parentDir);
      }

      if (entry.isDirectory) {
        if (!createdDirs.has(normalizedPath)) {
          await this.structureService.mkdirp(projectId, normalizedPath);
          createdDirs.add(normalizedPath);
        }
        totalFolders++;
        continue;
      }

      const storageType = entry.getStorageType();
      const existingNode = await this.structureService.getNodeByPath(
        projectId,
        normalizedPath,
      );

      if (storageType === 'doc') {
        const text = entry.data.toString('utf8').replace(/^\uFEFF/, '');
        const lines = text
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .split('\n');
        const textContent = lines.join('\n');

        if (existingNode && existingNode.type === 'DOC' && existingNode.docId) {
          const current = await this.docstoreService
            .getDoc(projectId, existingNode.docId)
            .catch(() => null);
          const nextVersion = (current?.version ?? 0) + 1;
          await this.docstoreService.updateDoc(projectId, existingNode.docId, {
            lines,
            version: nextVersion,
          });
          if (this.domainEventBus) {
            await this.domainEventBus.publish({
              type: 'manuscript.document.mutated',
              projectId,
              docId: existingNode.docId,
              lines,
              version: nextVersion,
              source: 'template-hydration',
              occurredAt: Date.now(),
            });
          } else {
            await this.liveCollab
              ?.applyExternalText(projectId, existingNode.docId, textContent)
              .catch(() => {});
          }
          docContentsMap.set(existingNode.docId, lines);
          totalDocs++;
          continue;
        }

        if (existingNode) {
          if (existingNode.fileId) {
            await this.filestoreService
              .deleteFile?.(projectId, existingNode.fileId, true)
              .catch(() => undefined);
          }
          await this.structureService
            .deleteNode(projectId, existingNode.id)
            .catch(() => undefined);
        }

        const doc = await this.docstoreService.createDoc(projectId, {
          path: normalizedPath,
          lines,
        });

        await this.structureService.createNode(projectId, {
          path: normalizedPath,
          name: baseName,
          type: 'DOC',
          docId: doc._id,
        });

        if (this.domainEventBus) {
          await this.domainEventBus.publish({
            type: 'manuscript.document.mutated',
            projectId,
            docId: doc._id,
            lines,
            version: doc.version ?? 1,
            source: 'template-hydration',
            occurredAt: Date.now(),
          });
        }

        docContentsMap.set(doc._id, lines);
        totalDocs++;
      } else {
        const mimeType = inferMimeType(entry.path);

        if (existingNode && existingNode.type === 'FILE') {
          const previousFileId = existingNode.fileId;
          const file = await this.filestoreService.uploadFileFromBuffer(
            projectId,
            baseName,
            entry.data,
            mimeType,
          );
          await this.structureService
            .updateNodeFileId(
              projectId,
              existingNode.id,
              file.id,
              entry.data.length,
              file.hash?.getValue() ?? String(file.hash),
            )
            .catch(async () => {
              const recheck = await this.structureService.getNodeByPath(
                projectId,
                normalizedPath,
              );
              if (recheck) {
                await this.structureService.updateNodeFileId(
                  projectId,
                  recheck.id,
                  file.id,
                  entry.data.length,
                  file.hash?.getValue() ?? String(file.hash),
                );
              }
            });
          if (previousFileId && previousFileId !== file.id) {
            await this.filestoreService
              .deleteFile?.(projectId, previousFileId, true)
              .catch(() => undefined);
          }
          totalFiles++;
          continue;
        }

        if (existingNode) {
          if (existingNode.fileId) {
            await this.filestoreService
              .deleteFile?.(projectId, existingNode.fileId, true)
              .catch(() => undefined);
          }
          await this.structureService
            .deleteNode(projectId, existingNode.id)
            .catch(() => undefined);
        }

        const file = await this.filestoreService.uploadFileFromBuffer(
          projectId,
          baseName,
          entry.data,
          mimeType,
        );

        const alreadyCreated = await this.structureService.getNodeByPath(
          projectId,
          normalizedPath,
        );
        if (!alreadyCreated) {
          await this.structureService.createNode(projectId, {
            path: normalizedPath,
            name: baseName,
            type: 'FILE',
            fileId: file.id,
          });
        }
        totalFiles++;
      }
    }

    let rootDocId: string | null = null;
    let rootDocPath: string | null = null;

    if (preferredRootDoc) {
      let cleanPreferred = preferredRootDoc.replace(/^\/+/, '');
      if (wrapperPrefix && cleanPreferred.startsWith(wrapperPrefix + '/')) {
        cleanPreferred = cleanPreferred.slice(wrapperPrefix.length + 1);
      }
      const preferredNorm = '/' + cleanPreferred;
      const match = await this.structureService.getNodeByPath(
        projectId,
        preferredNorm,
      );
      if (match && match.type === 'DOC') {
        const updated = await this.structureService.setRootDoc(
          projectId,
          match.id,
        );
        rootDocId = updated.docId || updated.id;
        rootDocPath = updated.path;
      }
    }

    if (!rootDocId) {
      const detected = await this.structureService.autoDetectRootDoc(
        projectId,
        docContentsMap,
      );

      if (detected) {
        rootDocId = detected.docId || detected.id;
        rootDocPath = detected.path;
      }
    }

    if (rootDocId) {
      const rootLines = docContentsMap.get(rootDocId);
      if (rootLines) {
        const fullText = rootLines.join('\n');
        const titleMatch = fullText.match(
          /\\title\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/,
        );
        if (titleMatch && titleMatch[1]) {
          const cleanTitle = titleMatch[1]
            .replace(/\\[a-zA-Z]+(?:\*|\b)?/g, '')
            .replace(/[\{\}]/g, '')
            .trim();
          if (cleanTitle) {
            const current = await this.docstoreService
              .getDoc(projectId, rootDocId)
              .catch(() => null);
            if (current) {
              const currentRanges =
                current.ranges && typeof current.ranges === 'object'
                  ? (current.ranges as Record<string, unknown>)
                  : {};
              const nextVersion = (current.version ?? 0) + 1;
              await this.docstoreService
                .updateDoc(projectId, rootDocId, {
                  lines: rootLines,
                  version: nextVersion,
                  ranges: { ...currentRanges, title: cleanTitle },
                })
                .catch(() => undefined);
              if (this.domainEventBus) {
                await this.domainEventBus.publish({
                  type: 'manuscript.document.mutated',
                  projectId,
                  docId: rootDocId,
                  lines: rootLines,
                  version: nextVersion,
                  source: 'template-hydration',
                  occurredAt: Date.now(),
                });
              }
            }
          }
        }
      }
    }

    return new ImportSummaryVo({
      projectId,
      totalEntries: entries.length,
      totalDocs,
      totalFiles,
      totalFolders,
      rootDocId,
      rootDocPath,
    });
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
        if (segments.length < 2) {
          return null;
        }
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
