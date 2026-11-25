/**
 * modules/pages/clsi/services/compile-source.service.ts
 * Bridges Flux DB/Storage (Prisma Page/PageNode/PageDoc/PageFile + Docstore + Filestore)
 * to the CLSI compile pipeline: resolves compile scope, plans the file set from lightweight
 * metadata, and hydrates changed text/binary files with LRU + disk-cache optimizations.
 */

import {
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaService, isUuid, mapWithConcurrency } from '@/core';
import {
  filterRecordsByPageScope,
  resolveSpaceRootDocIds,
  type PageScopeDbClient,
} from '@/modules/pages/core/page-scope.helper';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { FilestoreService } from '@/modules/pages/filestore/filestore.service';
import { CompilePageDto } from '../dto/compile.dto';
import {
  planDbFileSet,
  planInlineFileSet,
  linesToText,
  ManifestFile,
  PlannedFileSet,
} from '../domain/file-set.planner';
import {
  ClsiRepository,
  createUnchangedDiskPlaceholder,
} from '../clsi.repository';
import { SafePath } from '../domain/path.policy';
import { BoundedLruCache } from '../domain/lru-cache';

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
export class CompileSourceService {
  private readonly logger = new Logger(CompileSourceService.name);
  /**
   * Bounded LRU cache mapping `${spaceId}:${docId}` -> `{ token, content }` so `hydrateFiles`
   * only queries PostgreSQL (`SELECT lines FROM page_docs`) for the `O(Delta D)` documents whose
   * revision token (`d:${id}:${rev}:${updatedAt}:${sizeBytes}`) actually changed since the last build.
   */
  private readonly docContentCache = new BoundedLruCache<
    string,
    { token: string; content: string }
  >(CompileSourceService.MAX_CACHED_DOCS);
  private static readonly MAX_CACHED_DOCS = 2000;
  private static readonly MAX_CACHED_DOC_BYTES = 512 * 1024;

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly docstoreService?: DocstoreService,
    @Optional() private readonly filestoreService?: FilestoreService,
    @Optional() private readonly workspace?: ClsiRepository,
  ) {}

  /**
   * Resolve the owning space and canonical pageId when compiling or syncing.
   * Strict contract: `spaceId` is a Space UUID, `pageId` is a Page UUID.
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

    if (dto.pageId && dto.pageId !== 'default' && this.prisma && isUuid(dto.pageId)) {
      const page = await Promise.resolve(
        this.prisma.page?.findUnique?.({
          where: { id: dto.pageId },
          select: { id: true, spaceId: true },
        }),
      ).catch(() => null);
      if (page?.id) {
        resolvedSpaceId = page.spaceId;
        resolvedPageId = page.id;
      }
    }

    if (
      authorizedSpaceId &&
      dto.spaceId &&
      dto.spaceId !== 'default' &&
      dto.spaceId !== authorizedSpaceId
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'PROJECT_CONTEXT_MISMATCH',
        message: 'Authorized space context does not match compile payload',
      });
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

    return { spaceId, pageId: resolvedPageId };
  }

  /**
   * Plans the compile file set from lightweight metadata (no document bodies are read),
   * isolated by `(spaceId, pageId)` so multiple Pages in the same Space never merge trees.
   */
  public async planFiles(
    spaceId: string,
    dto: CompilePageDto,
    targetPageId?: string,
  ): Promise<PlannedFileSet> {
    const incomingFiles = { ...(dto.files || {}) };
    const mainFile = dto.mainFile || undefined;
    const source = dto.source || '';
    const effectiveScopePageId = targetPageId || dto.pageId;

    if (this.prisma && spaceId !== 'default') {
      try {
        const [rawNodes, rawDocs, rawBinaryFiles, rootDocIds] =
          await Promise.all([
            this.prisma.pageNode.findMany({
              where: { spaceId: spaceId },
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
              where: { spaceId: spaceId, deletedAt: null },
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
                    where: { spaceId: spaceId, deletedAt: null },
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
              spaceId,
              effectiveScopePageId,
            ),
          ]);
        const mappedNodes = rawNodes.map((n) => ({
          id: n.id,
          pageId: n.pageId,
          docId: n.docId,
          fileId: n.fileId,
          path: n.path,
          name: n.name,
          type: n.type,
          isRootDoc: Boolean(
            n.page?.rootDocId
              ? n.docId && n.docId === n.page.rootDocId
              : n.docId && rootDocIds.has(n.docId),
          ),
        }));
        const mappedDocs = rawDocs.map((d) => ({
          id: d.id,
          pageId: d.pageId,
          path: d.lastKnownPath ?? 'main.tex',
          rev: d.rev,
          sizeBytes: d.sizeBytes,
          updatedAt: d.updatedAt,
          inStorage: d.inStorage,
        }));
        const mappedBinaryFiles = rawBinaryFiles.map((bf) => ({
          id: bf.id,
          pageId: bf.pageId,
          name: bf.lastKnownPath ?? 'unnamed.bin',
          sizeBytes: bf.sizeBytes,
          hash: bf.hash,
          updatedAt: bf.updatedAt,
        }));
        const nodes = filterRecordsByPageScope(
          mappedNodes,
          effectiveScopePageId,
          spaceId,
        );
        const docs = filterRecordsByPageScope(
          mappedDocs,
          effectiveScopePageId,
          spaceId,
        );
        const binaryFiles = filterRecordsByPageScope(
          mappedBinaryFiles,
          effectiveScopePageId,
          spaceId,
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
        CompileSourceService.MAX_CACHED_DOC_BYTES
    ) {
      return;
    }
    this.docContentCache.set(cacheKey, { token, content });
  }

  /**
   * Loads document bodies for DB-backed entries in ONE `id IN (…)` query for only the
   * `O(Delta D)` documents whose revision token changed since the last compile,
   * unarchiving cold-storage docs via DocstoreService if available, and
   * materializing binary PageFile blobs via FilestoreService (or `O(1)` zero-copy
   * on-disk sentinels when `options?.deltaOnlyOnDisk` is enabled).
   */
  public async hydrateFiles(
    spaceId: string,
    plan: PlannedFileSet,
    scratchWorkspaceId: string = spaceId,
    options?: HydrateFilesOptions,
  ): Promise<Record<string, string | Buffer>> {
    const dbIds: string[] = [];
    const tokenByDocId = new Map<string, string>();
    const contentById = new Map<string, string>();

    for (const s of plan.files.values()) {
      if (s.kind !== 'db') continue;
      tokenByDocId.set(s.docId, s.token);
      const cacheKey = `${spaceId}:${s.docId}`;
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
                  spaceId,
                  row.id,
                );
                const text = linesToText(hydratedDoc.lines);
                contentById.set(row.id, text);
                this.setCachedDocContent(
                  `${spaceId}:${row.id}`,
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
            `${spaceId}:${row.id}`,
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

    if (this.prisma && this.filestoreService && spaceId !== 'default') {
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
              where: { spaceId: spaceId, deletedAt: null },
              select: {
                id: true,
                pageId: true,
                lastKnownPath: true,
                sizeBytes: true,
                hash: true,
              },
            }),
            this.prisma.pageNode.findMany({
              where: { spaceId: spaceId, type: 'FILE' },
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
            name: bf.lastKnownPath ?? 'unnamed.bin',
            sizeBytes: bf.sizeBytes,
            hash: bf.hash,
          }));
          binaryFiles =
            scratchWorkspaceId !== spaceId
              ? filterRecordsByPageScope(
                  rawBinaryFiles,
                  scratchWorkspaceId,
                  spaceId,
                )
              : rawBinaryFiles;
          fileNodes =
            scratchWorkspaceId !== spaceId
              ? filterRecordsByPageScope(
                  rawFileNodes,
                  scratchWorkspaceId,
                  spaceId,
                )
              : rawFileNodes;
        }

        const pathByFileId = new Map<string, string>();
        for (const n of fileNodes) {
          if (n.fileId) {
            const clean = SafePath.normalizeRelPath(n.path || n.name || '');
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
            pathByFileId.get(bf.id) || SafePath.normalizeRelPath(bf.name);
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
                  // and skip re-computing MD5 in ClsiRepository.syncFiles.
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
              spaceId,
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
          `Failed to load binary PageFile assets for project ${spaceId}: ${msg}`,
        );
      }
    }

    return out;
  }

}
