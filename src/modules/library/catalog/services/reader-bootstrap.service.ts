import { Injectable, Optional } from '@nestjs/common';
import {
  normalizeProjectScopeId,
  SingleFlightCoalescer,
} from '@/modules/library/core';
import { ItemQueryService } from '@/modules/library/catalog/services/item-query.service';
import { ItemFulltextService } from '@/modules/library/catalog/services/item-relations.service';
import { ItemDetail } from '@/modules/library/core/types/bibliographic.types';

export interface ReaderBootstrapOptions {
  projectId?: string;
  attachmentId?: string;
}

/**
 * Document-Scoped BFF Bootstrap Service for the Reader Subsystem.
 *
 * Separated from `LibraryBootstrapService` (Workspace-Scoped) in accordance with
 * Single Responsibility Principle (SRP):
 * - `LibraryBootstrapService`: Workspace-level collections, tags, savedSearches, counts, feeds.
 * - `ReaderBootstrapService`: Document-level item detail, active attachment, normalized annotations,
 *   fulltext document tree, explicit readingState, relations, notes, and scope permissions.
 */
@Injectable()
export class ReaderBootstrapService {
  private readonly singleFlight = new SingleFlightCoalescer();
  private static readonly BRANCH_DEADLINE_MS = 3_500;

  constructor(
    private readonly itemQueryService: ItemQueryService,
    @Optional() private readonly fulltextService?: ItemFulltextService,
  ) {}

  private withBranchDeadline<T>(promise: Promise<T>): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(
        () => resolve(undefined),
        ReaderBootstrapService.BRANCH_DEADLINE_MS,
      );
      if (typeof timer === 'object' && 'unref' in timer) {
        timer.unref();
      }
    });
    return Promise.race([
      promise.catch(() => undefined),
      timeout,
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private normalizeReaderRects(rawRects: unknown) {
    const rects: Array<Record<string, unknown>> = [];
    if (!Array.isArray(rawRects)) return rects;
    if (rawRects.length === 4 && rawRects.every((n) => typeof n === 'number')) {
      const [x1, y1, x2, y2] = rawRects as [number, number, number, number];
      rects.push({
        x1,
        y1,
        x2,
        y2,
        width: Math.max(0, x2 - x1),
        height: Math.max(0, y2 - y1),
      });
      return rects;
    }
    for (const entry of rawRects) {
      if (
        Array.isArray(entry) &&
        entry.length === 4 &&
        entry.every((n) => typeof n === 'number')
      ) {
        const [x1, y1, x2, y2] = entry as [number, number, number, number];
        rects.push({
          x1,
          y1,
          x2,
          y2,
          width: Math.max(0, x2 - x1),
          height: Math.max(0, y2 - y1),
        });
      } else if (entry && typeof entry === 'object') {
        const r = entry as Record<string, unknown>;
        const x1 =
          typeof r.x1 === 'number' ? r.x1 : typeof r.x === 'number' ? r.x : 0;
        const y1 =
          typeof r.y1 === 'number' ? r.y1 : typeof r.y === 'number' ? r.y : 0;
        const w = typeof r.width === 'number' ? r.width : undefined;
        const h = typeof r.height === 'number' ? r.height : undefined;
        const x2 =
          typeof r.x2 === 'number' ? r.x2 : w !== undefined ? x1 + w : x1;
        const y2 =
          typeof r.y2 === 'number' ? r.y2 : h !== undefined ? y1 + h : y1;
        rects.push({
          ...r,
          x1,
          y1,
          x2,
          y2,
          width: w ?? Math.max(0, x2 - x1),
          height: h ?? Math.max(0, y2 - y1),
        });
      }
    }
    return rects;
  }

  private normalizeReaderAnnotation(
    raw: Record<string, unknown>,
  ): Record<string, unknown> {
    const textVal =
      typeof raw.text === 'string'
        ? raw.text
        : typeof raw.quoteText === 'string'
          ? raw.quoteText
          : '';
    return {
      ...raw,
      text: textVal,
      quoteText: typeof raw.quoteText === 'string' ? raw.quoteText : textVal,
      rects: this.normalizeReaderRects(raw.rects ?? raw.rectCoords),
    };
  }

  async getReaderBootstrap(
    userId: string,
    itemId: string,
    options: ReaderBootstrapOptions = {},
    accessHint?: {
      role?: string;
      permissionOverrides?: Record<string, boolean> | null;
      effectivePermissions?: readonly string[];
    },
  ) {
    const validProjectId = normalizeProjectScopeId(options.projectId);
    const requestedAttachmentId = options.attachmentId?.trim() || undefined;
    const flightKey = [
      'reader-bootstrap',
      validProjectId ? `proj:${validProjectId}` : `user:${userId}`,
      userId,
      itemId,
      requestedAttachmentId || 'primary',
    ].join(':');

    return this.singleFlight.execute(flightKey, async () => {
      const [rawItem, fulltextResult, accessContract] = await Promise.all([
        this.itemQueryService.getItem(userId, itemId, validProjectId),
        this.fulltextService?.getFulltext
          ? this.withBranchDeadline(
              this.fulltextService.getFulltext(
                userId,
                itemId,
                validProjectId,
                requestedAttachmentId,
              ),
            )
          : Promise.resolve(undefined),
        this.withBranchDeadline(
          this.itemQueryService.getPermissions(
            userId,
            validProjectId,
            accessHint,
          ),
        ),
      ]);

      if (!rawItem) {
        return null;
      }

      const itemRec: Record<string, unknown> = { ...rawItem };
      const rawAttachments = Array.isArray(itemRec.attachments)
        ? (itemRec.attachments as Array<Record<string, unknown>>)
        : [];

      const normalizedAttachments: Array<Record<string, unknown>> =
        rawAttachments.map((att) => {
          if (!att || typeof att !== 'object') return att;
          const rawAnns = Array.isArray(att.annotations)
            ? (att.annotations as Array<Record<string, unknown>>)
            : [];
          return {
            ...att,
            annotations: rawAnns.map((ann) =>
              this.normalizeReaderAnnotation(ann),
            ),
          };
        });
      itemRec.attachments = normalizedAttachments;

      const primaryFileObj =
        itemRec.primaryFile && typeof itemRec.primaryFile === 'object'
          ? (itemRec.primaryFile as Record<string, unknown>)
          : null;
      const primaryAttachmentId =
        typeof primaryFileObj?.attachmentId === 'string'
          ? primaryFileObj.attachmentId
          : null;

      const selectedAttachment =
        (requestedAttachmentId
          ? normalizedAttachments.find(
              (a) =>
                a?.id === requestedAttachmentId ||
                a?.attachmentId === requestedAttachmentId,
            )
          : undefined) ||
        (primaryAttachmentId
          ? normalizedAttachments.find(
              (a) =>
                a?.id === primaryAttachmentId ||
                a?.attachmentId === primaryAttachmentId,
            )
          : undefined) ||
        normalizedAttachments.find(
          (a) =>
            a?.attachmentType === 'primary_pdf' && Boolean(a?.fileId || a?.url),
        ) ||
        normalizedAttachments.find(
          (a) =>
            a?.mimeType === 'application/pdf' && Boolean(a?.fileId || a?.url),
        ) ||
        normalizedAttachments.find((a) => Boolean(a?.fileId || a?.url)) ||
        normalizedAttachments[0] ||
        null;

      const activeAttachmentId =
        typeof selectedAttachment?.id === 'string'
          ? selectedAttachment.id
          : typeof selectedAttachment?.attachmentId === 'string'
            ? selectedAttachment.attachmentId
            : primaryAttachmentId;

      const annotations = Array.isArray(selectedAttachment?.annotations)
        ? (selectedAttachment.annotations as Array<Record<string, unknown>>)
        : [];

      const readingState = {
        readStatus:
          typeof itemRec.readStatus === 'string' ? itemRec.readStatus : 'unread',
        isStarred: Boolean(itemRec.isStarred),
        rating: typeof itemRec.rating === 'number' ? itemRec.rating : 0,
        currentPage:
          typeof itemRec.currentPage === 'number' ? itemRec.currentPage : null,
        lastReadPage:
          typeof itemRec.lastReadPage === 'number'
            ? itemRec.lastReadPage
            : typeof itemRec.currentPage === 'number'
              ? itemRec.currentPage
              : null,
        scrollPosition: itemRec.scrollPosition ?? null,
        lastReadAt:
          typeof itemRec.lastReadAt === 'string' ? itemRec.lastReadAt : null,
        lastOpenedAt:
          typeof itemRec.lastOpenedAt === 'string' ? itemRec.lastOpenedAt : null,
      };
      itemRec.readingState = readingState;

      const relations = Array.isArray(itemRec.relations)
        ? (itemRec.relations as Array<Record<string, unknown>>)
        : [];
      const notes = Array.isArray(itemRec.notes)
        ? (itemRec.notes as Array<Record<string, unknown>>)
        : [];

      const degradedBranches: string[] = [];
      if (this.fulltextService?.getFulltext && fulltextResult === undefined) {
        degradedBranches.push('fulltext');
      }
      if (accessContract === undefined) {
        degradedBranches.push('permissions');
      }

      return {
        scope: validProjectId ? ('project' as const) : ('user' as const),
        scopeId: validProjectId ?? userId,
        ...(degradedBranches.length > 0
          ? { degraded: true, degradedBranches }
          : {}),
        item: itemRec as unknown as ItemDetail,
        activeAttachmentId: activeAttachmentId ?? null,
        annotations,
        fulltext: fulltextResult ?? null,
        readingState,
        relations,
        notes,
        ...(accessContract
          ? {
              role: accessContract.role,
              permissions: accessContract.permissions,
            }
          : {}),
      };
    });
  }
}
