/**
 * modules/manuscripts/clsi/services/workspace-planner.service.ts
 * Service encapsulating project resolution, lightweight metadata planning,
 * database document hydration (including Docstore cold-storage unarchiving
 * and Filestore binary asset streaming), and post-compile snapshot checkpointing.
 */

import {
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Prisma } from '@prisma/client';
import { PrismaService, isUuid, mapWithConcurrency } from '@/core';
import {
  ensureCanonicalPageId,
  filterRecordsByPageScope,
  resolveSpaceRootDocIds,
  type PageScopeDbClient,
} from '@/modules/pages/core/page-scope.helper';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { FilestoreService } from '@/modules/pages/filestore/filestore.service';
import { RealtimeFacade } from '@/modules/realtime/realtime.facade';
import { CompilePageDto } from '../dto/clsi.dto';
import {
  planDbFileSet,
  planInlineFileSet,
  linesToText,
  ManifestFile,
  PlannedFileSet,
} from '../domain/fileset.planner';
import { FileSnapshotVo } from '@/modules/pages/project-history/domain/file-snapshot';
import {
  WorkspaceRepository,
  createUnchangedDiskPlaceholder,
} from '../repositories/workspace.repository';
import { SafePath } from '../domain/safe-path';

export interface HydrateFilesOptions {
  /**
   * When true, binary files already verified on disk in `scratchDir` (`stat.size === bf.sizeBytes`
   * and matching `.clsi-manifest.json` hash) are returned as 0-byte `UnchangedDiskBuffer` sentinels
   * (`O(1)` RAM, 0 bytes disk read, 0ms MD5 re-hash in `syncFiles`) instead of reading full buffers
   * from disk back into memory.
   */
  deltaOnlyOnDisk?: boolean;
}

@Injectable()
export class WorkspacePlannerService {
  private readonly logger = new Logger(WorkspacePlannerService.name);
  private readonly lastAutoSnapshotTimes = new Map<string, number>();
  private readonly lastSnapshotHashes = new Map<string, string>();
  /**
   * Bounded LRU cache mapping `${projectId}:${docId}` -> `{ token, content }` so `hydrateFiles`
   * only queries PostgreSQL (`SELECT lines FROM page_docs`) for the `O(Delta D)` documents whose
   * revision token (`d:${id}:${rev}:${updatedAt}:${sizeBytes}`) actually changed since the last build.
   */
  private readonly docContentCache = new Map<
    string,
    { token: string; content: string }
  >();
  private static readonly MAX_TRACKED_PROJECTS = 1000;
  private static readonly MAX_CACHED_DOCS = 2000;
  private static readonly MAX_CACHED_DOC_BYTES = 512 * 1024;

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly docstoreService?: DocstoreService,
    @Optional() private readonly filestoreService?: FilestoreService,
    @Optional() private readonly realtimeService?: RealtimeFacade,
    @Optional() private readonly workspace?: WorkspaceRepository,
  ) {}

  /**
   * Resolve the owning space and canonical manuscript pageId when compiling or syncing.
   * Rejects cross-tenant payload tampering if `authorizedSpaceId` does not own the resource.
   */
  public async resolvePageCompileContext(
    dto: {
      spaceId?: string;
      pageId?: string;
    },
    authorizedSpaceId?: string,
  ): Promise<{ spaceId: string; pageId?: string }> {
    let resolvedSpaceId: string | undefined;
    let resolvedPageId: string | undefined;

    const inspectIdentifier = async (
      candidate?: string,
    ): Promise<{ spaceId?: string; pageId?: string } | null> => {
      if (
        !candidate ||
        candidate === 'default' ||
        !this.prisma ||
        !isUuid(candidate)
      ) {
        return null;
      }
      const page = await Promise.resolve(
        this.prisma.page?.findUnique?.({
          where: { id: candidate },
          select: { id: true, spaceId: true },
        }),
      ).catch(() => null);
      if (page?.id) {
        return { spaceId: page.spaceId, pageId: page.id };
      }

      const pageDoc = await Promise.resolve(
        this.prisma.pageDoc?.findUnique?.({
          where: { id: candidate },
          select: { id: true, spaceId: true, pageId: true },
        }),
      ).catch(() => null);
      if (pageDoc) {
        const sId =
          pageDoc.spaceId ??
          (pageDoc as { projectId?: string } | null)?.projectId;
        const pId =
          (pageDoc as { pageId?: string | null }).pageId || pageDoc.id;
        return { spaceId: sId, pageId: pId };
      }

      const node = await Promise.resolve(
        this.prisma.pageNode?.findUnique?.({
          where: { id: candidate },
          select: { spaceId: true, pageId: true, docId: true },
        }),
      ).catch(() => null);
      if (node) {
        return {
          spaceId: node.spaceId,
          pageId:
            (node as { pageId?: string | null }).pageId ||
            node.docId ||
            undefined,
        };
      }

      return null;
    };

    const pageInfo = await inspectIdentifier(dto.pageId);
    if (pageInfo?.spaceId) {
      resolvedSpaceId = pageInfo.spaceId;
      resolvedPageId = pageInfo.pageId;
    }

    if (dto.spaceId && dto.spaceId !== 'default') {
      const projAsEntityInfo = await inspectIdentifier(dto.spaceId);
      if (projAsEntityInfo?.spaceId) {
        if (
          authorizedSpaceId &&
          projAsEntityInfo.spaceId !== authorizedSpaceId
        ) {
          throw new ForbiddenException({
            statusCode: 403,
            code: 'PROJECT_CONTEXT_MISMATCH',
            message: 'Authorized space context does not match compile payload',
          });
        }
        if (!resolvedSpaceId) resolvedSpaceId = projAsEntityInfo.spaceId;
        if (!resolvedPageId) resolvedPageId = projAsEntityInfo.pageId;
      } else if (
        authorizedSpaceId &&
        dto.spaceId !== authorizedSpaceId &&
        dto.spaceId !== resolvedPageId
      ) {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'PROJECT_CONTEXT_MISMATCH',
          message: 'Authorized space context does not match compile payload',
        });
      }
    }

    if (
      authorizedSpaceId &&
      resolvedSpaceId &&
      resolvedSpaceId !== 'default' &&
      resolvedSpaceId !== authorizedSpaceId
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'PROJECT_CONTEXT_MISMATCH',
        message: 'Authorized space context does not match compile payload',
      });
    }

    const spaceId =
      authorizedSpaceId ||
      resolvedSpaceId ||
      (dto.spaceId && dto.spaceId !== 'default' ? dto.spaceId : 'default');

    if (resolvedPageId && resolvedPageId === spaceId) {
      resolvedPageId = undefined;
    }

    return { spaceId, pageId: resolvedPageId };
  }

  /**
   * Resolve the owning project when only a page/doc id was supplied.
   */
  public async resolveProjectId(dto: {
    spaceId?: string;
    pageId?: string;
  }): Promise<string> {
    const { spaceId } = await this.resolvePageCompileContext(dto);
    return spaceId;
  }

  /**
   * Plans the compile file set from lightweight metadata (no document bodies are read),
   * isolated by `(spaceId, pageId)` so multiple Pages in the same Space never merge trees.
   */
  public async planFiles(
    projectId: string,
    dto: CompilePageDto,
    manuscriptPageId?: string,
  ): Promise<PlannedFileSet> {
    const incomingFiles = { ...(dto.files || {}) };
    const mainFile = dto.mainFile || undefined;
    const source = dto.source || '';
    const effectiveScopePageId = manuscriptPageId || dto.pageId;

    if (this.prisma && projectId !== 'default') {
      try {
        const [rawNodes, rawDocs, rawBinaryFiles, rootDocIds] =
          await Promise.all([
            this.prisma.pageNode.findMany({
              where: { spaceId: projectId },
              orderBy: { sortOrder: 'asc' },
              select: {
                id: true,
                pageId: true,
                docId: true,
                fileId: true,
                path: true,
                name: true,
                type: true,
                page: { select: { rootDocId: true } },
              },
            }),
            this.prisma.pageDoc.findMany({
              where: { spaceId: projectId, deletedAt: null },
              select: {
                id: true,
                pageId: true,
                lastKnownPath: true,
                rev: true,
                sizeBytes: true,
                updatedAt: true,
                inStorage: true,
              },
            }),
            this.prisma.pageFile?.findMany
              ? this.prisma.pageFile
                  .findMany({
                    where: { spaceId: projectId, deletedAt: null },
                    select: {
                      id: true,
                      pageId: true,
                      lastKnownPath: true,
                      sizeBytes: true,
                      hash: true,
                      updatedAt: true,
                    },
                  })
                  .catch(() => [])
              : Promise.resolve([]),
            resolveSpaceRootDocIds(
              this.prisma as unknown as PageScopeDbClient,
              projectId,
              effectiveScopePageId,
            ),
          ]);
        const mappedNodes = rawNodes.map((n) => {
          const nCompat = n as {
            page?: { rootDocId?: string | null } | null;
            isRootDoc?: boolean;
          };
          return {
            id: n.id,
            pageId: n.pageId,
            docId: n.docId,
            fileId: n.fileId,
            path: n.path,
            name: n.name,
            type: n.type,
            isRootDoc: Boolean(
              nCompat.page?.rootDocId
                ? n.docId && n.docId === nCompat.page.rootDocId
                : (n.docId && rootDocIds.has(n.docId)) || nCompat.isRootDoc,
            ),
          };
        });
        const mappedDocs = rawDocs.map((d) => ({
          id: d.id,
          pageId: d.pageId,
          path:
            d.lastKnownPath ??
            (d as { path?: string | null }).path ??
            'main.tex',
          rev: d.rev,
          sizeBytes: d.sizeBytes,
          updatedAt: d.updatedAt,
          inStorage: d.inStorage,
        }));
        const mappedBinaryFiles = rawBinaryFiles.map((bf) => ({
          id: bf.id,
          pageId: bf.pageId,
          name:
            bf.lastKnownPath ?? (bf as { name?: string }).name ?? 'unnamed.bin',
          sizeBytes: bf.sizeBytes,
          hash: bf.hash,
          updatedAt: bf.updatedAt,
        }));
        const nodes = filterRecordsByPageScope(
          mappedNodes,
          effectiveScopePageId,
          projectId,
        );
        const docs = filterRecordsByPageScope(
          mappedDocs,
          effectiveScopePageId,
          projectId,
        );
        const binaryFiles = filterRecordsByPageScope(
          mappedBinaryFiles,
          effectiveScopePageId,
          projectId,
        );
        return planDbFileSet({
          nodes,
          docs,
          binaryFiles,
          incomingFiles,
          source,
          mainFile,
          pageId: effectiveScopePageId,
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

  private getCachedDocContent(
    cacheKey: string,
    expectedToken: string,
  ): string | undefined {
    const entry = this.docContentCache.get(cacheKey);
    if (!entry || entry.token !== expectedToken) {
      return undefined;
    }
    // Refresh LRU order
    this.docContentCache.delete(cacheKey);
    this.docContentCache.set(cacheKey, entry);
    return entry.content;
  }

  private setCachedDocContent(
    cacheKey: string,
    token: string | undefined,
    content: string,
  ): void {
    if (
      !token ||
      Buffer.byteLength(content, 'utf8') >
        WorkspacePlannerService.MAX_CACHED_DOC_BYTES
    ) {
      return;
    }
    if (this.docContentCache.has(cacheKey)) {
      this.docContentCache.delete(cacheKey);
    } else if (
      this.docContentCache.size >= WorkspacePlannerService.MAX_CACHED_DOCS
    ) {
      const oldestKey = this.docContentCache.keys().next().value;
      if (oldestKey) {
        this.docContentCache.delete(oldestKey);
      }
    }
    this.docContentCache.set(cacheKey, { token, content });
  }

  /**
   * Loads document bodies for DB-backed entries in ONE `id IN (…)` query for only the
   * `O(Delta D)` documents whose revision token changed since the last compile,
   * unarchiving cold-storage docs via DocstoreService if available, and
   * materializing binary ManuscriptFile blobs via FilestoreService (or `O(1)` zero-copy
   * on-disk sentinels when `options?.deltaOnlyOnDisk` is enabled).
   */
  public async hydrateFiles(
    projectId: string,
    plan: PlannedFileSet,
    scratchWorkspaceId: string = projectId,
    options?: HydrateFilesOptions,
  ): Promise<Record<string, string | Buffer>> {
    const dbIds: string[] = [];
    const tokenByDocId = new Map<string, string>();
    const contentById = new Map<string, string>();

    for (const s of plan.files.values()) {
      if (s.kind !== 'db') continue;
      tokenByDocId.set(s.docId, s.token);
      const cacheKey = `${projectId}:${s.docId}`;
      const cachedText = this.getCachedDocContent(cacheKey, s.token);
      if (cachedText !== undefined) {
        contentById.set(s.docId, cachedText);
      } else {
        dbIds.push(s.docId);
      }
    }

    if (dbIds.length > 0 && this.prisma) {
      const rows = await this.prisma.pageDoc.findMany({
        where: { id: { in: dbIds } },
        select: { id: true, lines: true, inStorage: true, sizeBytes: true },
      });
      await Promise.all(
        rows.map(async (row) => {
          const hasInlineLines =
            Array.isArray(row.lines) && row.lines.length > 0;
          if (row.inStorage && row.sizeBytes > 0 && !hasInlineLines) {
            if (this.docstoreService) {
              try {
                const hydratedDoc = await this.docstoreService.getDoc(
                  projectId,
                  row.id,
                );
                const text = linesToText(hydratedDoc.lines);
                contentById.set(row.id, text);
                this.setCachedDocContent(
                  `${projectId}:${row.id}`,
                  tokenByDocId.get(row.id),
                  text,
                );
                return;
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
          const text = linesToText(row.lines);
          contentById.set(row.id, text);
          this.setCachedDocContent(
            `${projectId}:${row.id}`,
            tokenByDocId.get(row.id),
            text,
          );
        }),
      );
    }

    const out: Record<string, string | Buffer> = {};
    for (const [filePath, s] of plan.files) {
      out[filePath] =
        s.kind === 'inline' ? s.content : (contentById.get(s.docId) ?? '');
    }

    if (this.prisma && this.filestoreService && projectId !== 'default') {
      try {
        let binaryFiles: ManifestFile[];
        let fileNodes: Array<{
          fileId?: string | null;
          path?: string | null;
          name?: string | null;
        }>;
        if (plan.binaryFiles && plan.nodes) {
          binaryFiles = plan.binaryFiles;
          fileNodes = plan.nodes.filter((n) => n.type === 'FILE');
        } else {
          const [rawBinaryFilesFromDb, rawFileNodes] = await Promise.all([
            this.prisma.pageFile.findMany({
              where: { spaceId: projectId, deletedAt: null },
              select: {
                id: true,
                pageId: true,
                lastKnownPath: true,
                sizeBytes: true,
                hash: true,
              },
            }),
            this.prisma.pageNode.findMany({
              where: { spaceId: projectId, type: 'FILE' },
              select: {
                id: true,
                pageId: true,
                fileId: true,
                path: true,
                name: true,
              },
            }),
          ]);
          const rawBinaryFiles = rawBinaryFilesFromDb.map((bf) => ({
            id: bf.id,
            pageId: bf.pageId,
            name:
              bf.lastKnownPath ??
              (bf as { name?: string }).name ??
              'unnamed.bin',
            sizeBytes: bf.sizeBytes,
            hash: bf.hash,
          }));
          binaryFiles =
            scratchWorkspaceId !== projectId
              ? filterRecordsByPageScope(
                  rawBinaryFiles,
                  scratchWorkspaceId,
                  projectId,
                )
              : rawBinaryFiles;
          fileNodes =
            scratchWorkspaceId !== projectId
              ? filterRecordsByPageScope(
                  rawFileNodes,
                  scratchWorkspaceId,
                  projectId,
                )
              : rawFileNodes;
        }

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

        const scratchDir = this.workspace?.getScratchDir(scratchWorkspaceId);

        let manifestFiles: Record<string, string> = {};
        if (scratchDir) {
          try {
            const rawManifest = await fs.readFile(
              path.join(scratchDir, '.clsi-manifest.json'),
              'utf8',
            );
            const parsed = JSON.parse(rawManifest) as {
              files?: Record<string, string>;
            };
            manifestFiles = parsed.files || {};
          } catch {
            manifestFiles = {};
          }
        }

        await mapWithConcurrency(binaryFiles, 8, async (bf) => {
          const relPath =
            pathByFileId.get(bf.id) ||
            bf.name
              .trim()
              .replace(/\\/g, '/')
              .replace(/^(\.\/)+/, '')
              .replace(/^\/+/, '');
          if (!relPath || out[relPath] !== undefined) return;

          // Disk-cache hit optimization: if workspace already has the exact asset on disk
          // matching both sizeBytes and hash, read from local disk instead of remote storage.
          if (scratchDir) {
            try {
              const localAssetPath = await SafePath.assertSafeWorkspacePath(
                scratchDir,
                relPath,
              );
              const stat = await fs.lstat(localAssetPath);
              const manifestHash = manifestFiles[relPath];
              const hashMatches =
                !bf.hash ||
                (manifestHash?.length === bf.hash.length
                  ? manifestHash === bf.hash
                  : Boolean(manifestHash));
              if (
                !stat.isSymbolicLink() &&
                stat.isFile() &&
                bf.sizeBytes &&
                stat.size === bf.sizeBytes &&
                hashMatches
              ) {
                if (options?.deltaOnlyOnDisk && manifestHash) {
                  // O(1) Zero-Copy Disk Hit: skip reading 50MB binary file from disk into RAM
                  // and skip re-computing MD5 in WorkspaceRepository.syncFiles.
                  out[relPath] = createUnchangedDiskPlaceholder(manifestHash);
                } else {
                  out[relPath] = await fs.readFile(localAssetPath);
                }
                return;
              }
            } catch {
              // Asset not present on disk or unsafe path, proceed with stream fetch
            }
          }

          try {
            const { stream } = await this.filestoreService!.openReadStream(
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
            this.logger.warn(
              `Missing binary asset ${bf.id} (${relPath}): ${msg}. Generating fallback placeholder to prevent compiler halt.`,
            );
            if (relPath.toLowerCase().endsWith('.pdf')) {
              out[relPath] = Buffer.from(
                '%PDF-1.4\n1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj\n2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj\n3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]>> endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000056 00000 n \n0000000111 00000 n \ntrailer <</Size 4 /Root 1 0 R>>\nstartxref\n190\n%%EOF\n',
                'utf8',
              );
            } else {
              out[relPath] = Buffer.from(
                '89504e470d0a1a0a0000000d49484452000000640000006408020000004fb0b79f000000097048597300000ec300000ec301c76fa8640000002149444154789c63601805a360148c24000000ffff03008880000188812f860000000049454e44ae426082',
                'hex',
              );
            }
          }
        });
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
    plan?: PlannedFileSet,
    manuscriptPageId?: string,
  ): Promise<void> {
    if (!this.prisma || !projectId || projectId === 'default') return;

    const preResolveKey = manuscriptPageId
      ? `${projectId}:${manuscriptPageId}`
      : projectId;
    const preLastTime = this.lastAutoSnapshotTimes.get(preResolveKey) || 0;
    if (Date.now() - preLastTime < 30000) return;

    try {
      const canonicalPageId = await ensureCanonicalPageId(
        this.prisma,
        projectId,
        manuscriptPageId,
      );
      const snapshotScopeKey = `${projectId}:${canonicalPageId}`;
      const lastTime = this.lastAutoSnapshotTimes.get(snapshotScopeKey) || 0;
      if (Date.now() - lastTime < 30000) return;

      const [latest, projectDocs, projectNodes, fallbackRootDocIds] =
        await Promise.all([
          this.prisma.pageSnapshot.findFirst({
            where: { spaceId: projectId, pageId: canonicalPageId },
            orderBy: { version: 'desc' },
            select: { version: true },
          }),
          plan?.docs
            ? Promise.resolve(plan.docs)
            : this.prisma.pageDoc?.findMany
              ? this.prisma.pageDoc
                  .findMany({
                    where: {
                      spaceId: projectId,
                      pageId: canonicalPageId,
                      deletedAt: null,
                    },
                    select: { id: true, lastKnownPath: true },
                  })
                  .then((rows) =>
                    rows.map((r) => ({
                      id: r.id,
                      path:
                        r.lastKnownPath ??
                        (r as { path?: string | null }).path ??
                        '',
                    })),
                  )
                  .catch(() => [])
              : Promise.resolve([]),
          plan?.nodes
            ? Promise.resolve(plan.nodes)
            : this.prisma.pageNode?.findMany
              ? this.prisma.pageNode
                  .findMany({
                    where: { spaceId: projectId, pageId: canonicalPageId },
                    select: {
                      docId: true,
                      path: true,
                      page: { select: { rootDocId: true } },
                    },
                  })
                  .catch(() => [])
              : Promise.resolve([]),
          resolveSpaceRootDocIds(
            this.prisma as unknown as PageScopeDbClient,
            projectId,
            canonicalPageId,
          ),
        ]);

      const docIdByNormalizedPath = new Map<string, string>();
      const rootDocPaths = new Set<string>();
      for (const d of projectDocs || []) {
        const docPath =
          (d as { path?: string | null; lastKnownPath?: string }).path ??
          (d as { lastKnownPath?: string }).lastKnownPath;
        if (docPath && d.id) {
          const norm = docPath.startsWith('/') ? docPath : `/${docPath}`;
          docIdByNormalizedPath.set(norm, d.id);
        }
      }
      for (const n of projectNodes || []) {
        if (n.path) {
          const norm = n.path.startsWith('/') ? n.path : `/${n.path}`;
          if (n.docId) {
            docIdByNormalizedPath.set(norm, n.docId);
          }
          const nCompat = n as {
            isRootDoc?: boolean;
            page?: { rootDocId?: string | null } | null;
          };
          const isRoot = Boolean(
            nCompat.isRootDoc ||
            (nCompat.page?.rootDocId && n.docId === nCompat.page.rootDocId) ||
            (n.docId && fallbackRootDocIds.has(n.docId)),
          );
          if (isRoot) {
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
      if (
        this.lastSnapshotHashes.get(snapshotScopeKey) === projectContentHash
      ) {
        // Content did not change since last snapshot; update timestamp to prevent thrashing
        this.lastAutoSnapshotTimes.set(snapshotScopeKey, Date.now());
        return;
      }

      let candidateVersion = nextVersion;
      const maxAttempts = 3;
      let savedVersion = candidateVersion;
      const serializedFiles = JSON.stringify(filesJson);
      const snapshotSizeBytes = Buffer.byteLength(serializedFiles, 'utf8');

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          await this.prisma.pageSnapshot.create({
            data: {
              spaceId: projectId,
              pageId: canonicalPageId,
              version: candidateVersion,
              summary: `Compilation milestone (${metricEngine})`,
              createdById: userId || null,
              isAutomatic: true,
              files: filesJson as unknown as Prisma.InputJsonValue,
              sizeBytes: snapshotSizeBytes,
            },
          });
          savedVersion = candidateVersion;
          break;
        } catch (err: unknown) {
          const code = (err as { code?: string })?.code;
          if (code === 'P2002' && attempt < maxAttempts - 1) {
            const currentLatest = await this.prisma.pageSnapshot.findFirst({
              where: { spaceId: projectId, pageId: canonicalPageId },
              orderBy: { version: 'desc' },
              select: { version: true },
            });
            candidateVersion = Math.max(
              candidateVersion + 1,
              (currentLatest?.version ?? 0) + 1,
            );
            continue;
          }
          throw err;
        }
      }

      // Bounded cache maintenance to prevent memory leaks across thousands of projects
      if (
        this.lastAutoSnapshotTimes.size >=
        WorkspacePlannerService.MAX_TRACKED_PROJECTS
      ) {
        const oldestKey = this.lastAutoSnapshotTimes.keys().next().value;
        if (oldestKey) {
          this.lastAutoSnapshotTimes.delete(oldestKey);
          this.lastSnapshotHashes.delete(oldestKey);
        }
      }
      this.lastAutoSnapshotTimes.set(snapshotScopeKey, Date.now());
      this.lastSnapshotHashes.set(snapshotScopeKey, projectContentHash);
      this.realtimeService?.broadcastSnapshotCreated(projectId, {
        version: savedVersion,
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

/** @deprecated Use WorkspacePlannerService */
export { WorkspacePlannerService as ClsiWorkspacePlannerService };
