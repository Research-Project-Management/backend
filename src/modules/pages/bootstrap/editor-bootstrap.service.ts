/**
 * modules/pages/bootstrap/editor-bootstrap.service.ts
 * Unified BFF Deep Module hydrating all 3 Editor blocks in 1 HTTP round-trip:
 * - Block 1 (Explorer & Outline): Flat VFS tree (`FOLDER` + `DOC` + `FILE`) & project symbols
 * - Block 2 (Topbar & Active Editor): Workspace metadata/permissions & 1 active file buffer
 * - Block 3 (PDF Preview & Diagnostics): Last CLSI build metadata (0 raw PDF bytes)
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PageDoc, PageNode } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import { Role, RoleHierarchy } from '@/modules/project/access';
import { PageService } from '@/modules/pages/page/services/page.service';
import { isRecordDeleted } from '@/modules/pages/core/utils/page-scope';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import {
  findPageRecordWithNode,
  formatPageByIdResponse,
} from '@/modules/pages/docstore/services/doc-occ.helper';
import { StructureService } from '@/modules/pages/structure/structure.service';
import { NodePathVo } from '@/modules/pages/structure/domain';
import {
  ClsiService,
  type EditorLastBuildSummary,
} from '@/modules/pages/clsi/clsi.service';
import type {
  BootstrapEditorParams,
  EditorBootstrapActiveDocDto,
  EditorBootstrapDegradedBranch,
  EditorBootstrapResponseDto,
  EditorBootstrapTreeNodeDto,
} from './editor-bootstrap.types';

const DEFAULT_SOFT_BRANCH_DEADLINE_MS = 2_000;

class BranchDeadlineError extends Error {
  constructor(
    public readonly branch: EditorBootstrapDegradedBranch,
    public readonly timeoutMs: number,
  ) {
    super(
      `Editor bootstrap branch "${branch}" exceeded ${timeoutMs}ms deadline`,
    );
    this.name = 'BranchDeadlineError';
  }
}

class SingleFlightCoalescer {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  public run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }
    const promise = Promise.resolve()
      .then(fn)
      .finally(() => {
        if (this.inFlight.get(key) === promise) {
          this.inFlight.delete(key);
        }
      });
    this.inFlight.set(key, promise);
    return promise;
  }
}

async function withBranchDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  branch: EditorBootstrapDegradedBranch,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new BranchDeadlineError(branch, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

type PageDocWithNode = PageDoc & { node: PageNode | null };

const PAGE_ROW_SELECT = {
  id: true,
  rootDocId: true,
  title: true,
  spaceId: true,
  deletedAt: true,
} as const;

function buildPathOrFilter(cleanPath: string) {
  return [
    { node: { path: `/${cleanPath}` } },
    { lastKnownPath: `/${cleanPath}` },
    { lastKnownPath: cleanPath },
  ];
}

function matchesPageScope(
  candidate: PageDocWithNode,
  spaceId: string,
  canonicalPageId: string,
  rootDocId?: string,
  isScopedPage = false,
): boolean {
  const candidatePageId = (candidate as { pageId?: string | null }).pageId;
  if (
    candidatePageId &&
    canonicalPageId &&
    candidatePageId !== canonicalPageId &&
    (isScopedPage || candidatePageId !== spaceId)
  ) {
    return false;
  }
  if (isScopedPage && !candidatePageId && candidate.id !== rootDocId) {
    return false;
  }
  return true;
}

@Injectable()
export class EditorBootstrapService {
  private readonly logger = new Logger(EditorBootstrapService.name);
  private readonly coalescer = new SingleFlightCoalescer();
  private readonly defaultSoftBranchDeadlineMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pageService: PageService,
    private readonly docstoreService: DocstoreService,
    private readonly structureService: StructureService,
    private readonly clsiService: ClsiService,
    @Optional() softBranchDeadlineMs?: number,
  ) {
    this.defaultSoftBranchDeadlineMs =
      typeof softBranchDeadlineMs === 'number' && softBranchDeadlineMs > 0
        ? softBranchDeadlineMs
        : DEFAULT_SOFT_BRANCH_DEADLINE_MS;
  }

  public async bootstrapEditor(
    params: BootstrapEditorParams,
  ): Promise<EditorBootstrapResponseDto> {
    const requestedFileKey = params.requestedFileId?.trim() || 'root';
    const resolvedAuthProjectId = this.pageService.resolveActiveProjectId(
      params.authorizedProjectId as string | { id: string } | null | undefined,
    );
    if (!params.userId) {
      return this.executeBootstrap(params, resolvedAuthProjectId);
    }
    const roleKey = String(params.role || 'viewer').toLowerCase();
    const coalesceKey = `editor-boot:${resolvedAuthProjectId || 'auto'}:${params.userId}:${roleKey}:${params.pageOrProjectId}:${requestedFileKey}`;

    return this.coalescer.run(coalesceKey, () =>
      this.executeBootstrap(params, resolvedAuthProjectId),
    );
  }

  private async executeBootstrap(
    params: BootstrapEditorParams,
    resolvedAuthProjectId?: string,
  ): Promise<EditorBootstrapResponseDto> {
    const spaceId =
      resolvedAuthProjectId ||
      (await this.pageService.resolveProjectId(params.pageOrProjectId));

    if (!spaceId) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: `Workspace or document ${params.pageOrProjectId} not found`,
      });
    }

    const [
      projectRow,
      deletedDocs,
      entryRecord,
      initialPageRow,
      githubLinkRow,
    ] = await Promise.all([
      Promise.resolve(
        this.prisma.project?.findUnique?.({
          where: { id: spaceId },
          select: { id: true, name: true },
        }),
      ).catch(() => null),
      Promise.resolve(
        this.prisma.pageDoc?.findMany?.({
          where: { spaceId, deletedAt: { not: null } },
          select: { id: true },
        }),
      ).catch(() => []),
      findPageRecordWithNode(this.prisma, params.pageOrProjectId, spaceId),
      params.pageOrProjectId === spaceId
        ? Promise.resolve(
            this.prisma.page?.findFirst?.({
              where: { spaceId, deletedAt: null },
              orderBy: { createdAt: 'asc' },
              select: PAGE_ROW_SELECT,
            }),
          ).catch(() => null)
        : isUuid(params.pageOrProjectId)
          ? Promise.resolve(
              this.prisma.page?.findUnique?.({
                where: { id: params.pageOrProjectId },
                select: PAGE_ROW_SELECT,
              }),
            ).catch(() => null)
          : Promise.resolve(null),
      params.userId && isUuid(params.userId) && isUuid(params.pageOrProjectId)
        ? Promise.resolve(
            this.prisma.pageGithubLink?.findFirst?.({
              where: {
                pageId: params.pageOrProjectId,
                page: { spaceId, deletedAt: null },
              },
              select: {
                id: true,
                repoFullName: true,
                branch: true,
                lastSyncedAt: true,
              },
            }),
          ).catch(() => null)
        : Promise.resolve(null),
    ]);

    if (params.pageOrProjectId !== spaceId) {
      if (
        initialPageRow &&
        (isRecordDeleted(initialPageRow) || initialPageRow.spaceId !== spaceId)
      ) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'RESOURCE_NOT_FOUND',
          message: `Document ${params.pageOrProjectId} not found`,
        });
      }
      if (!initialPageRow && isUuid(params.pageOrProjectId)) {
        const entryMatchesParam =
          entryRecord &&
          !isRecordDeleted(entryRecord) &&
          (entryRecord.id === params.pageOrProjectId ||
            entryRecord.node?.id === params.pageOrProjectId ||
            (entryRecord as { pageId?: string | null }).pageId ===
              params.pageOrProjectId);
        if (!entryMatchesParam) {
          throw new NotFoundException({
            statusCode: 404,
            code: 'RESOURCE_NOT_FOUND',
            message: `Document ${params.pageOrProjectId} not found`,
          });
        }
      }
    }

    const entryPageId = (entryRecord as { pageId?: string | null } | null)
      ?.pageId;
    const pageRow =
      initialPageRow &&
      !isRecordDeleted(initialPageRow) &&
      initialPageRow.spaceId === spaceId
        ? initialPageRow
        : entryPageId && isUuid(entryPageId)
          ? await Promise.resolve(
              this.prisma.page?.findUnique?.({
                where: { id: entryPageId },
                select: PAGE_ROW_SELECT,
              }),
            ).catch(() => null)
          : null;

    const validPageRow =
      pageRow && !isRecordDeleted(pageRow) && pageRow.spaceId === spaceId
        ? pageRow
        : null;

    const manuscriptPageId =
      validPageRow?.id ||
      (entryPageId && entryPageId !== spaceId ? entryPageId : undefined) ||
      (!isRecordDeleted(entryRecord) && entryRecord?.id !== spaceId
        ? entryRecord?.id
        : undefined);

    const allNodes = await this.structureService.getAllNodes(
      spaceId,
      undefined,
      manuscriptPageId,
    );

    const scopedAllNodes =
      validPageRow && allNodes.some((n) => n.pageId === validPageRow.id)
        ? allNodes.filter((n) => n.pageId === validPageRow.id)
        : allNodes;

    const deletedDocIds = new Set(
      Array.isArray(deletedDocs)
        ? deletedDocs.map((d) => d.id).filter(Boolean)
        : [],
    );

    const validNodes = scopedAllNodes.filter((node) => {
      if (node.type === 'DOC' && node.docId && deletedDocIds.has(node.docId)) {
        return false;
      }
      return true;
    });

    const hasScopedPageContext = Boolean(
      validPageRow ||
      (entryPageId && entryPageId !== spaceId) ||
      validNodes.some((n) => Boolean(n.pageId && n.pageId !== spaceId)),
    );

    const rootNode =
      (validPageRow?.rootDocId
        ? validNodes.find((n) => n.docId === validPageRow.rootDocId)
        : undefined) ??
      validNodes.find((n) => n.isRootDoc && n.docId) ??
      validNodes.find((n) => n.type === 'DOC' && n.docId);

    const entryMatchesValidPage =
      !validPageRow ||
      (entryRecord &&
        (entryRecord.id === validPageRow.rootDocId ||
          entryPageId === validPageRow.id));

    const rootDocId =
      (validPageRow?.rootDocId && !deletedDocIds.has(validPageRow.rootDocId)
        ? validPageRow.rootDocId
        : undefined) ??
      rootNode?.docId ??
      (entryRecord && !isRecordDeleted(entryRecord) && entryMatchesValidPage
        ? entryRecord.id
        : undefined);

    if (!rootDocId) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: `Document ${params.pageOrProjectId} not found`,
      });
    }

    let rootRecord: PageDocWithNode | null =
      entryRecord &&
      entryRecord.id === rootDocId &&
      !isRecordDeleted(entryRecord)
        ? entryRecord
        : await findPageRecordWithNode(this.prisma, rootDocId, spaceId);

    if (!rootRecord || isRecordDeleted(rootRecord)) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: `Document ${params.pageOrProjectId} not found`,
      });
    }

    const canonicalPageId = manuscriptPageId || rootRecord.id;

    // Graceful File Fallback Invariant: missing/deleted ?fileId falls back to rootDoc within this Page
    let activeRecord: PageDocWithNode = rootRecord;
    let fallbackToRoot = false;
    const explicitFileId = params.requestedFileId?.trim() || undefined;

    if (
      explicitFileId &&
      explicitFileId !== rootRecord.id &&
      explicitFileId !== `${rootRecord.id}-main`
    ) {
      const candidateDoc = await this.findStrictActiveDocCandidate(
        spaceId,
        canonicalPageId,
        explicitFileId,
        rootRecord.id,
        hasScopedPageContext,
      );
      if (candidateDoc && !isRecordDeleted(candidateDoc)) {
        activeRecord = candidateDoc;
      } else {
        activeRecord = rootRecord;
        fallbackToRoot = true;
      }
    } else if (
      !explicitFileId &&
      entryRecord &&
      !isRecordDeleted(entryRecord) &&
      entryRecord.id !== rootRecord.id &&
      (!entryPageId || entryPageId === canonicalPageId) &&
      (validNodes.length === 0 ||
        validNodes.some((n) => n.docId === entryRecord.id))
    ) {
      activeRecord = entryRecord;
    }

    // Live-Flush Invariant: flush pending Yjs buffers before reading active doc
    const flushTargets = Array.from(new Set([rootRecord.id, activeRecord.id]));
    const liveCollab = this.pageService.getLiveCollaboration();
    if (liveCollab) {
      const flushedIds = await liveCollab
        .flushDocs(spaceId, flushTargets)
        .catch((): string[] => []);
      if (Array.isArray(flushedIds) && flushedIds.length > 0) {
        const refreshedActive = await this.prisma.pageDoc
          .findFirst({
            where: { id: activeRecord.id, spaceId, deletedAt: null },
            include: { node: true },
          })
          .catch(() => null);
        if (refreshedActive) {
          activeRecord = refreshedActive;
        }
        if (rootRecord.id === activeRecord.id) {
          rootRecord = activeRecord;
        } else if (flushedIds.includes(rootRecord.id)) {
          const refreshedRoot = await this.prisma.pageDoc
            .findFirst({
              where: { id: rootRecord.id, spaceId, deletedAt: null },
              include: { node: true },
            })
            .catch(() => null);
          if (refreshedRoot) {
            rootRecord = refreshedRoot;
          }
        }
      }
    }

    const rootRecordPath =
      rootRecord.node?.path ||
      rootRecord.lastKnownPath ||
      (rootRecord as { path?: string }).path ||
      'main.tex';
    const mainFilePath =
      NodePathVo.toRelative(rootNode?.path || rootRecordPath || 'main.tex') ||
      'main.tex';
    const rootRanges =
      rootRecord.ranges && typeof rootRecord.ranges === 'object'
        ? (rootRecord.ranges as Record<string, unknown>)
        : {};
    const workspaceTitle =
      (validPageRow?.title && validPageRow.title.trim()
        ? validPageRow.title
        : undefined) ||
      (typeof rootRanges.title === 'string' && rootRanges.title.trim()
        ? rootRanges.title
        : undefined) ||
      projectRow?.name ||
      rootNode?.name ||
      mainFilePath;

    const tree: EditorBootstrapTreeNodeDto[] =
      validNodes.length > 0
        ? validNodes.map(
            (n) => n.toJSON() as unknown as EditorBootstrapTreeNodeDto,
          )
        : [
            {
              id: rootRecord.node?.id || rootRecord.id,
              spaceId,
              projectId: spaceId,
              pageId: canonicalPageId,
              parentId: null,
              type: 'DOC',
              name: mainFilePath,
              path: rootRecordPath.startsWith('/')
                ? rootRecordPath
                : `/${rootRecordPath}`,
              depth: 1,
              docId: rootRecord.id,
              fileId: null,
              isRootDoc: true,
              sizeBytes: rootRecord.sizeBytes || 0,
              hash: rootRecord.hash ?? null,
              rev: rootRecord.rev ?? 1,
              sortOrder: 0,
              createdAt:
                rootRecord.createdAt instanceof Date
                  ? rootRecord.createdAt.toISOString()
                  : rootRecord.createdAt,
              updatedAt:
                rootRecord.updatedAt instanceof Date
                  ? rootRecord.updatedAt.toISOString()
                  : rootRecord.updatedAt,
            },
          ];

    const normalizedRole = (params.role || Role.REVIEWER).toLowerCase();
    const roleRank =
      RoleHierarchy[normalizedRole as Role] ?? RoleHierarchy[Role.REVIEWER];
    const canEdit = roleRank >= RoleHierarchy[Role.CONTRIBUTOR];

    // Phase 2: Hydrate activeDoc alongside Soft Branches bounded by per-branch deadline (reusing validNodes)
    const deadlineMs =
      params.softBranchDeadlineMs ?? this.defaultSoftBranchDeadlineMs;
    const degradedBranches: EditorBootstrapDegradedBranch[] = [];

    const fallbackLastBuild: EditorLastBuildSummary = {
      status: 'uncompiled',
      pdfArtifactUrl: null,
      synctexAvailable: false,
      lastCompiledAt: null,
      diagnostics: [],
    };

    const [formatted, symbols, lastBuild] = await Promise.all([
      formatPageByIdResponse(this.docstoreService, activeRecord),
      withBranchDeadline(
        this.structureService.getProjectSymbols(
          spaceId,
          canonicalPageId,
          validNodes,
        ),
        deadlineMs,
        'symbols',
      ).catch((err) => {
        this.logger.warn(
          `[EditorBootstrap] Degraded symbols branch for space ${spaceId} page ${canonicalPageId}: ${(err as Error)?.message || err}`,
        );
        degradedBranches.push('symbols');
        return null;
      }),
      withBranchDeadline(
        this.clsiService.getLastBuildSummary(
          spaceId,
          mainFilePath,
          canonicalPageId,
        ),
        deadlineMs,
        'lastBuild',
      ).catch((err) => {
        this.logger.warn(
          `[EditorBootstrap] Degraded lastBuild branch for space ${spaceId} page ${canonicalPageId}: ${(err as Error)?.message || err}`,
        );
        degradedBranches.push('lastBuild');
        return fallbackLastBuild;
      }),
    ]);

    const activeRecordPath =
      activeRecord.node?.path ||
      activeRecord.lastKnownPath ||
      (activeRecord as { path?: string }).path;
    const activeHash =
      (formatted as { hash?: string | null }).hash ?? activeRecord.hash ?? null;
    const activeDoc: EditorBootstrapActiveDocDto = {
      id: activeRecord.id,
      nodeId: activeRecord.node?.id ?? null,
      page: {
        ...formatted.page,
        spaceId,
        pageId: canonicalPageId,
        path: activeRecordPath,
        mainFile: { id: rootRecord.id, title: mainFilePath },
        mainFileId: rootRecord.id,
        rootPageId: canonicalPageId,
        hash: activeHash,
      },
      lines: Array.isArray(formatted.lines) ? formatted.lines : [],
      version: formatted.version ?? activeRecord.version ?? 1,
      rev: formatted.rev ?? activeRecord.rev ?? 1,
      hash: activeHash,
      ranges: (formatted.ranges && typeof formatted.ranges === 'object'
        ? formatted.ranges
        : activeRecord.ranges || {}) as Record<string, unknown>,
      fallbackToRoot,
    };

    const githubLink =
      projectRow && githubLinkRow
        ? {
            id: githubLinkRow.id,
            repoFullName: githubLinkRow.repoFullName,
            branch: githubLinkRow.branch || 'main',
            lastSyncedAt:
              githubLinkRow.lastSyncedAt instanceof Date
                ? githubLinkRow.lastSyncedAt.toISOString()
                : (githubLinkRow.lastSyncedAt ?? null),
          }
        : null;

    return {
      workspace: {
        spaceId,
        spaceType: projectRow ? 'project' : 'personal',
        pageId: canonicalPageId,
        rootDocId: rootRecord.id,
        projectName: projectRow?.name ?? null,
        title: workspaceTitle,
        mainFilePath,
        permissions: {
          role: normalizedRole,
          canEdit,
          canCompile: canEdit,
        },
        githubLink,
      },
      tree,
      activeDoc,
      symbols,
      lastBuild,
      degraded: degradedBranches.length > 0,
      degradedBranches,
      serverTimestamp: new Date().toISOString(),
    };
  }

  private async findStrictActiveDocCandidate(
    spaceId: string,
    canonicalPageId: string,
    explicitFileId: string,
    rootDocId?: string,
    isScopedPage = false,
  ): Promise<PageDocWithNode | null> {
    if (isUuid(explicitFileId)) {
      const candidate = await this.prisma.pageDoc
        .findFirst({
          where: {
            spaceId,
            deletedAt: null,
            OR: [{ id: explicitFileId }, { node: { id: explicitFileId } }],
          },
          include: { node: true },
        })
        .catch(() => null);
      if (!candidate) return null;
      return matchesPageScope(
        candidate,
        spaceId,
        canonicalPageId,
        rootDocId,
        isScopedPage,
      )
        ? candidate
        : null;
    }

    const cleanPath = explicitFileId.replace(/^\/+/, '');
    const pathOr = buildPathOrFilter(cleanPath);
    const scopedCandidate = await this.prisma.pageDoc
      .findFirst({
        where: {
          spaceId,
          ...(canonicalPageId ? { pageId: canonicalPageId } : {}),
          deletedAt: null,
          OR: pathOr,
        },
        include: { node: true },
      })
      .catch(() => null);
    if (scopedCandidate) {
      const scopedCandidatePageId = (
        scopedCandidate as { pageId?: string | null }
      ).pageId;
      if (
        !isScopedPage ||
        scopedCandidatePageId === canonicalPageId ||
        scopedCandidate.id === rootDocId
      ) {
        return scopedCandidate;
      }
    }

    const legacyCandidate = await this.prisma.pageDoc
      .findFirst({
        where: {
          spaceId,
          deletedAt: null,
          OR: pathOr,
        },
        include: { node: true },
      })
      .catch(() => null);
    if (!legacyCandidate) return null;
    return matchesPageScope(
      legacyCandidate,
      spaceId,
      canonicalPageId,
      rootDocId,
      isScopedPage,
    )
      ? legacyCandidate
      : null;
  }
}
