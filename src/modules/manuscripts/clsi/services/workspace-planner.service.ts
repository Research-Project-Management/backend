/**
 * modules/manuscripts/clsi/services/workspace-planner.service.ts
 * Service encapsulating project resolution, lightweight metadata planning,
 * database document hydration (including Docstore cold-storage unarchiving
 * and Filestore binary asset streaming), and post-compile snapshot checkpointing.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/core';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { FilestoreService } from '@/modules/manuscripts/filestore/filestore.service';
import { RealtimeFacade } from '@/modules/realtime/realtime.facade';
import { CompileManuscriptDto } from '../dto/clsi.dto';
import {
  planDbFileSet,
  planInlineFileSet,
  linesToText,
  PlannedFileSet,
} from '../domain/compile-fileset.planner';
import { FileSnapshotVo } from '@/modules/manuscripts/project-history/domain/file-snapshot.vo';
import { OverleafIncrementalWorkspace } from '../repositories/incremental-workspace.repository';

@Injectable()
export class ClsiWorkspacePlannerService {
  private readonly logger = new Logger(ClsiWorkspacePlannerService.name);
  private readonly lastAutoSnapshotTimes = new Map<string, number>();
  private readonly lastSnapshotHashes = new Map<string, string>();
  private static readonly MAX_TRACKED_PROJECTS = 1000;

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly docstoreService?: DocstoreService,
    @Optional() private readonly filestoreService?: FilestoreService,
    @Optional() private readonly realtimeService?: RealtimeFacade,
    @Optional() private readonly workspace?: OverleafIncrementalWorkspace,
  ) {}

  /**
   * Resolve the owning project when only a page/doc id was supplied.
   */
  public async resolveProjectId(dto: {
    projectId?: string;
    project_id?: string;
    pageId?: string;
    page_id?: string;
  }): Promise<string> {
    const pageId = dto.pageId || dto.page_id;
    if (pageId && this.prisma) {
      try {
        const pageDoc = await this.prisma.manuscriptDoc.findUnique({
          where: { id: pageId },
          select: { projectId: true },
        });
        if (pageDoc?.projectId) return pageDoc.projectId;
      } catch {
        /* fall through */
      }
    }

    const projectId = dto.projectId || dto.project_id || '';
    if (projectId) return projectId;

    return 'default';
  }

  /**
   * Plans the compile file set from lightweight metadata (no document bodies are read),
   * so the cache can be consulted before any heavy I/O happens.
   */
  public async planFiles(
    projectId: string,
    dto: CompileManuscriptDto,
  ): Promise<PlannedFileSet> {
    const incomingFiles = { ...(dto.files || {}) };
    const mainFile = dto.main_file || undefined;
    const source = dto.source || '';

    if (this.prisma && projectId !== 'default') {
      try {
        const [nodes, docs] = await Promise.all([
          this.prisma.manuscriptNode.findMany({
            where: { projectId },
            orderBy: { sortOrder: 'asc' },
            select: {
              id: true,
              docId: true,
              path: true,
              name: true,
              type: true,
              isRootDoc: true,
            },
          }),
          this.prisma.manuscriptDoc.findMany({
            where: { projectId, deleted: false },
            select: {
              id: true,
              path: true,
              rev: true,
              sizeBytes: true,
              updatedAt: true,
              inStorage: true,
            },
          }),
        ]);
        return planDbFileSet({
          nodes,
          docs,
          incomingFiles,
          source,
          mainFile,
          pageId: dto.pageId || dto.page_id,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Could not load project documents from database: ${msg}`,
        );
      }
    }
    return planInlineFileSet({ incomingFiles, source, mainFile });
  }

  /**
   * Loads document bodies for DB-backed entries in ONE `id IN (…)` query,
   * unarchiving cold-storage docs via DocstoreService if available, and
   * materializing binary ManuscriptFile blobs via FilestoreService.
   */
  public async hydrateFiles(
    projectId: string,
    plan: PlannedFileSet,
  ): Promise<Record<string, string | Buffer>> {
    const dbIds: string[] = [];
    for (const s of plan.files.values()) {
      if (s.kind !== 'db') continue;
      dbIds.push(s.docId);
    }

    const contentById = new Map<string, string>();
    if (dbIds.length > 0 && this.prisma) {
      const rows = await this.prisma.manuscriptDoc.findMany({
        where: { id: { in: dbIds } },
        select: { id: true, lines: true, inStorage: true, sizeBytes: true },
      });
      for (const row of rows) {
        const hasInlineLines = Array.isArray(row.lines) && row.lines.length > 0;
        if (row.inStorage && row.sizeBytes > 0 && !hasInlineLines) {
          if (this.docstoreService) {
            try {
              const hydratedDoc = await this.docstoreService.getDoc(
                projectId,
                row.id,
              );
              contentById.set(row.id, linesToText(hydratedDoc.lines));
              continue;
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              this.logger.warn(
                `Failed to unarchive cold-storage doc ${row.id} via DocstoreService: ${msg}`,
              );
            }
          } else {
            this.logger.warn(
              `Cold-storage doc ${row.id} (${row.sizeBytes}B) has no inline body and DocstoreService is unavailable; compiling as empty.`,
            );
          }
        }
        contentById.set(row.id, linesToText(row.lines));
      }
    }

    const out: Record<string, string | Buffer> = {};
    for (const [filePath, s] of plan.files) {
      out[filePath] =
        s.kind === 'inline' ? s.content : (contentById.get(s.docId) ?? '');
    }

    if (this.prisma && this.filestoreService && projectId !== 'default') {
      try {
        const [binaryFiles, fileNodes] = await Promise.all([
          this.prisma.manuscriptFile.findMany({
            where: { projectId, deleted: false, deletedAt: null },
            select: { id: true, name: true, sizeBytes: true, hash: true },
          }),
          this.prisma.manuscriptNode.findMany({
            where: { projectId, type: 'FILE' },
            select: { fileId: true, path: true, name: true },
          }),
        ]);

        const pathByFileId = new Map<string, string>();
        for (const n of fileNodes) {
          if (n.fileId) {
            const clean = (n.path || n.name || '')
              .trim()
              .replace(/\\/g, '/')
              .replace(/^(\.\/)+/, '')
              .replace(/^\/+/, '');
            if (clean) pathByFileId.set(n.fileId, clean);
          }
        }

        const scratchDir = this.workspace?.getScratchDir(projectId);

        for (const bf of binaryFiles) {
          const relPath =
            pathByFileId.get(bf.id) ||
            bf.name
              .trim()
              .replace(/\\/g, '/')
              .replace(/^(\.\/)+/, '')
              .replace(/^\/+/, '');
          if (!relPath || out[relPath] !== undefined) continue;

          // Disk-cache hit optimization: if workspace already has the exact asset on disk, reuse it
          if (scratchDir) {
            const localAssetPath = path.join(scratchDir, relPath);
            try {
              const stat = await fs.stat(localAssetPath);
              if (bf.sizeBytes && stat.size === bf.sizeBytes) {
                // Asset is already on local disk with identical byte length; skip re-downloading to RAM
                continue;
              }
            } catch {
              // Asset not present on disk, proceed with stream fetch
            }
          }

          try {
            const { stream } = await this.filestoreService.openReadStream(
              projectId,
              bf.id,
            );
            const chunks: Buffer[] = [];
            for await (const chunk of stream) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            out[relPath] = Buffer.concat(chunks);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.debug(
              `Skipping missing binary asset ${bf.id} (${relPath}): ${msg}`,
            );
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to load binary ManuscriptFile assets for project ${projectId}: ${msg}`,
        );
      }
    }

    return out;
  }

  /**
   * Continuous Automated History Checkpoint (Overleaf Parity)
   */
  public async recordCompileSnapshotIfEligible(
    projectId: string,
    mergedFiles: Record<string, string | Buffer>,
    metricEngine: string,
    userId?: string,
  ): Promise<void> {
    if (!this.prisma || !projectId || projectId === 'default') return;

    const lastTime = this.lastAutoSnapshotTimes.get(projectId) || 0;
    if (Date.now() - lastTime < 30000) return;

    try {
      const [latest, projectDocs, projectNodes] = await Promise.all([
        this.prisma.manuscriptSnapshot.findFirst({
          where: { projectId },
          orderBy: { version: 'desc' },
          select: { version: true },
        }),
        this.prisma.manuscriptDoc?.findMany
          ? this.prisma.manuscriptDoc
              .findMany({
                where: { projectId, deleted: false },
                select: { id: true, path: true },
              })
              .catch(() => [])
          : Promise.resolve([]),
        this.prisma.manuscriptNode?.findMany
          ? this.prisma.manuscriptNode
              .findMany({
                where: { projectId },
                select: { docId: true, path: true, isRootDoc: true },
              })
              .catch(() => [])
          : Promise.resolve([]),
      ]);

      const docIdByNormalizedPath = new Map<string, string>();
      const rootDocPaths = new Set<string>();
      for (const d of projectDocs || []) {
        if (d.path && d.id) {
          const norm = d.path.startsWith('/') ? d.path : `/${d.path}`;
          docIdByNormalizedPath.set(norm, d.id);
        }
      }
      for (const n of projectNodes || []) {
        if (n.path) {
          const norm = n.path.startsWith('/') ? n.path : `/${n.path}`;
          if (n.docId) {
            docIdByNormalizedPath.set(norm, n.docId);
          }
          if (n.isRootDoc) {
            rootDocPaths.add(norm);
          }
        }
      }

      const nextVersion = (latest?.version ?? 0) + 1;
      const filesJson: Record<string, unknown> = {};
      const hashAccumulator = crypto.createHash('sha256');

      for (const [p, content] of Object.entries(mergedFiles)) {
        if (typeof content !== 'string') continue;
        const normalizedPath = p.startsWith('/') ? p : `/${p}`;
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        hashAccumulator.update(`${normalizedPath}:${hash};`);
        const lines = content.split('\n');
        const resolvedDocId = docIdByNormalizedPath.get(normalizedPath) || '';
        const isRootDoc =
          rootDocPaths.size > 0
            ? rootDocPaths.has(normalizedPath)
            : normalizedPath === '/main.tex';
        filesJson[normalizedPath] = FileSnapshotVo.createDoc(
          normalizedPath,
          resolvedDocId,
          lines,
          hash,
          isRootDoc,
        ).toJSON();
      }
      if (Object.keys(filesJson).length === 0) return;

      const projectContentHash = hashAccumulator.digest('hex');
      if (this.lastSnapshotHashes.get(projectId) === projectContentHash) {
        // Content did not change since last snapshot; update timestamp to prevent thrashing
        this.lastAutoSnapshotTimes.set(projectId, Date.now());
        return;
      }

      await this.prisma.manuscriptSnapshot.create({
        data: {
          projectId,
          version: nextVersion,
          summary: `Compilation milestone (${metricEngine})`,
          createdById: userId || null,
          isAutomatic: true,
          files: filesJson as unknown as Prisma.InputJsonValue,
          sizeBytes: Object.keys(filesJson).length,
        },
      });

      // Bounded cache maintenance to prevent memory leaks across thousands of projects
      if (this.lastAutoSnapshotTimes.size >= ClsiWorkspacePlannerService.MAX_TRACKED_PROJECTS) {
        const oldestKey = this.lastAutoSnapshotTimes.keys().next().value;
        if (oldestKey) {
          this.lastAutoSnapshotTimes.delete(oldestKey);
          this.lastSnapshotHashes.delete(oldestKey);
        }
      }
      this.lastAutoSnapshotTimes.set(projectId, Date.now());
      this.lastSnapshotHashes.set(projectId, projectContentHash);
      this.realtimeService?.broadcastSnapshotCreated(projectId, {
        version: nextVersion,
        summary: `Compilation milestone (${metricEngine})`,
        label: null,
      });
    } catch (snapErr) {
      this.logger.debug(
        `Continuous history auto-snapshot skipped for ${projectId}: ${snapErr}`,
      );
    }
  }
}
