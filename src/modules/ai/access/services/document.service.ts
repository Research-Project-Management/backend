import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccessRepository } from '../access.repository';
import {
  extractRagDocIdFromMetadata,
  hasDirectFileOwnership,
} from '../domain/access.policy';
import type {
  EnrichedAttachedSource,
  ResolvedChatDocuments,
  ResolvedPaperTarget,
} from '../types/access.type';
import { SpaceAccessService } from './space.service';

interface ResolvedLibrarySourceInfo {
  itemId: string;
  title: string;
  fileId: string | null;
  ragDocId: string | null;
  hasPdf: boolean;
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readPositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function readNonNegativeInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return undefined;
}

@Injectable()
export class DocumentAccessService {
  constructor(
    private readonly repo: AccessRepository,
    private readonly spaceAccess: SpaceAccessService,
  ) {}

  private async resolveLibraryItemsMap(
    ids: string[],
    knownFileRagIds?: ReadonlyMap<string, string | null>,
  ): Promise<Map<string, ResolvedLibrarySourceInfo>> {
    const itemInfoMap = new Map<string, ResolvedLibrarySourceInfo>();
    if (ids.length === 0) return itemInfoMap;

    const items = await this.repo.findLibraryItemsWithAttachments(ids);
    const pendingFileIds: string[] = [];
    const primaryAttByItem = new Map<
      string,
      { fileId: string | null; ragDocId: string | null }
    >();

    for (const item of items) {
      const attachments = item.attachments || [];
      const primaryAtt =
        attachments.find((att) => att.attachmentType === 'primary_pdf') ||
        attachments[0];
      const fileId = primaryAtt?.fileId ?? null;

      let ragDocId = extractRagDocIdFromMetadata(item.metadata);
      if (!ragDocId && primaryAtt) {
        ragDocId = extractRagDocIdFromMetadata(primaryAtt.metadata);
        if (!ragDocId && fileId) {
          if (knownFileRagIds?.has(fileId)) {
            ragDocId = knownFileRagIds.get(fileId) ?? null;
          } else {
            pendingFileIds.push(fileId);
          }
        }
      }
      primaryAttByItem.set(item.id, { fileId, ragDocId });
    }

    const fileMetaById = new Map<string, string>();
    if (pendingFileIds.length > 0) {
      const uniqueFileIds = Array.from(new Set(pendingFileIds));
      const storageFiles =
        await this.repo.findStorageFilesMetadata(uniqueFileIds);
      for (const file of storageFiles) {
        const extracted = extractRagDocIdFromMetadata(file.metadata);
        if (extracted) {
          fileMetaById.set(file.id, extracted);
        }
      }
    }

    for (const item of items) {
      const resolved = primaryAttByItem.get(item.id);
      const fileId = resolved?.fileId ?? null;
      const ragDocId =
        resolved?.ragDocId ?? (fileId ? (fileMetaById.get(fileId) ?? null) : null);

      const itemTitle =
        typeof (item as { title?: unknown }).title === 'string'
          ? ((item as { title?: string }).title ?? '')
          : '';

      itemInfoMap.set(item.id, {
        itemId: item.id,
        title: itemTitle,
        fileId,
        ragDocId,
        hasPdf: Boolean(fileId),
      });
    }

    return itemInfoMap;
  }

  async resolveChatDocuments(
    documentIds: string[],
    rawSources?: unknown,
  ): Promise<ResolvedChatDocuments> {
    const rawList: unknown[] = Array.isArray(rawSources) ? rawSources : [];
    if (documentIds.length === 0 && rawList.length === 0) {
      return { resolvedDocumentIds: [], enrichedSources: [] };
    }

    const docMap = new Map<string, string>();
    const foundFileIds = new Set<string>();
    const knownFileRagIds = new Map<string, string | null>();

    if (documentIds.length > 0) {
      const files = await this.repo.findStorageFilesMetadata(documentIds);
      for (const file of files) {
        foundFileIds.add(file.id);
        const ragDocId = extractRagDocIdFromMetadata(file.metadata);
        knownFileRagIds.set(file.id, ragDocId);
        if (ragDocId) {
          docMap.set(file.id, ragDocId);
        }
      }
    }

    const candidateIdSet = new Set<string>();
    for (const rawId of documentIds) {
      const cleanId = readTrimmedString(rawId);
      if (cleanId && !foundFileIds.has(cleanId)) {
        candidateIdSet.add(cleanId);
      }
    }

    for (const entry of rawList) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const kind = readTrimmedString(rec.kind);
      if (kind && kind !== 'paper' && kind !== 'library') continue;
      for (const field of ['item_id', 'itemId', 'source_id', 'sourceId', 'id']) {
        const candidate = readTrimmedString(rec[field]);
        if (candidate && !foundFileIds.has(candidate)) {
          candidateIdSet.add(candidate);
        }
      }
    }

    const itemInfoMap = await this.resolveLibraryItemsMap(
      Array.from(candidateIdSet),
      knownFileRagIds,
    );

    const resolvedDocumentIds = documentIds.map((id) => {
      const trimmed = readTrimmedString(id);
      const itemInfo =
        itemInfoMap.get(id) ?? (trimmed ? itemInfoMap.get(trimmed) : undefined);
      return (
        docMap.get(id) ??
        (trimmed ? docMap.get(trimmed) : undefined) ??
        itemInfo?.ragDocId ??
        itemInfo?.fileId ??
        id
      );
    });

    const enrichedSources = this.buildEnrichedSources(
      rawList,
      documentIds,
      itemInfoMap,
    );

    return { resolvedDocumentIds, enrichedSources };
  }

  async resolvePaperTarget(
    userId: string,
    paperOrFileId: string,
  ): Promise<ResolvedPaperTarget> {
    const item = await this.repo.findLibraryItemDetail(paperOrFileId);
    if (item) {
      const canAccess =
        item.createdById === userId ||
        (await this.spaceAccess.hasSpaceOrProjectAccess(userId, item.spaceId));

      if (!canAccess) {
        throw new ForbiddenException('You do not have access to this paper');
      }

      const primaryAtt =
        item.attachments && item.attachments.length > 0
          ? item.attachments.find(
              (att) => att.attachmentType === 'primary_pdf',
            ) || item.attachments[0]
          : undefined;
      const primaryFileId = primaryAtt?.fileId ?? null;

      let ragDocId = extractRagDocIdFromMetadata(item.metadata);

      if (!ragDocId && primaryAtt) {
        ragDocId = extractRagDocIdFromMetadata(primaryAtt.metadata);
        if (!ragDocId && primaryAtt.fileId) {
          const fileMeta = await this.repo.findStorageFileMetadata(
            primaryAtt.fileId,
          );
          ragDocId = extractRagDocIdFromMetadata(fileMeta);
        }
      }

      const itemMeta =
        item.metadata && typeof item.metadata === 'object'
          ? (item.metadata as Record<string, unknown>)
          : {};
      const pageCount =
        readPositiveInt(primaryAtt?.pageCount) ??
        readPositiveInt(itemMeta.pageCount) ??
        readPositiveInt(itemMeta.totalPages) ??
        readPositiveInt(itemMeta.total_pages);
      const citationCount =
        readNonNegativeInt(itemMeta.citationCount) ??
        readNonNegativeInt(itemMeta.citedByCount) ??
        readNonNegativeInt(itemMeta.cited_by_count);

      return {
        itemId: item.id,
        fileId: primaryFileId,
        title: item.title,
        authors: item.contributors?.map((c) => c.fullName) || [],
        year: item.year ?? undefined,
        doi: item.doi ?? undefined,
        arxivId: item.arxivId ?? undefined,
        venue: item.publicationTitle ?? undefined,
        pageCount,
        citationCount,
        abstract: item.abstract ?? undefined,
        ragDocId,
        spaceId: item.spaceId || userId,
      };
    }

    const file = await this.repo.findStorageFileDetail(paperOrFileId, userId);
    if (file) {
      let canAccess = hasDirectFileOwnership(file, userId);
      if (!canAccess && file.spaceId) {
        canAccess = await this.spaceAccess.hasSpaceOrProjectAccess(
          userId,
          file.spaceId,
        );
      }
      if (
        !canAccess &&
        file.linkedToType?.toLowerCase() === 'project' &&
        file.linkedToId
      ) {
        canAccess = await this.spaceAccess.hasSpaceOrProjectAccess(
          userId,
          file.linkedToId,
        );
      }

      if (!canAccess) {
        throw new ForbiddenException('You do not have access to this file');
      }

      const meta =
        file.metadata && typeof file.metadata === 'object'
          ? (file.metadata as {
              title?: unknown;
              authors?: unknown;
              year?: unknown;
              doi?: unknown;
              abstract?: unknown;
              ragDocId?: unknown;
            })
          : {};

      const spaceId =
        file.spaceId ||
        (file.linkedToType?.toLowerCase() === 'project' && file.linkedToId
          ? file.linkedToId
          : userId);

      const authors = Array.isArray(meta.authors)
        ? meta.authors.filter((a): a is string => typeof a === 'string')
        : typeof meta.authors === 'string'
          ? [meta.authors]
          : [];

      return {
        itemId: null,
        fileId: file.id,
        title: typeof meta.title === 'string' ? meta.title : file.filename,
        authors,
        year:
          typeof meta.year === 'number' || typeof meta.year === 'string'
            ? meta.year
            : undefined,
        doi: typeof meta.doi === 'string' ? meta.doi : undefined,
        abstract: typeof meta.abstract === 'string' ? meta.abstract : undefined,
        ragDocId: typeof meta.ragDocId === 'string' ? meta.ragDocId : null,
        spaceId,
      };
    }

    const parentItemId =
      await this.repo.findAttachmentParentItemId(paperOrFileId);
    if (parentItemId) {
      return this.resolvePaperTarget(userId, parentItemId);
    }

    throw new NotFoundException(
      `Paper or scientific file with ID ${paperOrFileId} not found`,
    );
  }

  private buildEnrichedSources(
    rawList: unknown[],
    documentIds: string[],
    itemInfoMap: ReadonlyMap<string, ResolvedLibrarySourceInfo>,
  ): EnrichedAttachedSource[] {
    const enriched: EnrichedAttachedSource[] = [];
    for (const entry of rawList) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const rawKind = readTrimmedString(rec.kind);
      const kind: 'library' | 'upload' | 'paper' =
        rawKind === 'library'
          ? 'library'
          : rawKind === 'paper'
            ? 'paper'
            : 'upload';

      let matched: ResolvedLibrarySourceInfo | undefined;
      if (kind !== 'upload') {
        for (const field of ['item_id', 'itemId', 'source_id', 'sourceId', 'id']) {
          const candidate = readTrimmedString(rec[field]);
          if (candidate && itemInfoMap.has(candidate)) {
            matched = itemInfoMap.get(candidate);
            break;
          }
        }
      }

      if (matched) {
        enriched.push({
          kind: rawKind === 'library' ? 'library' : 'paper',
          title: readTrimmedString(rec.title) || matched.title,
          source_id: matched.ragDocId || matched.fileId,
          source_type: 'file',
          item_id: matched.itemId,
          file_id: matched.fileId,
          has_pdf: matched.hasPdf,
          indexed: Boolean(matched.ragDocId),
        });
        continue;
      }

      const sourceId =
        readTrimmedString(rec.source_id) ?? readTrimmedString(rec.sourceId);
      const itemId =
        readTrimmedString(rec.item_id) ?? readTrimmedString(rec.itemId);
      const fileId =
        readTrimmedString(rec.file_id) ?? readTrimmedString(rec.fileId);
      const title = readTrimmedString(rec.title) ?? '';
      if (!sourceId && !itemId && !fileId && !title) continue;

      const rawSourceType =
        readTrimmedString(rec.source_type) ??
        readTrimmedString(rec.sourceType);
      const sourceType: 'upload' | 'file' | null =
        rawSourceType === 'upload'
          ? 'upload'
          : rawSourceType === 'file'
            ? 'file'
            : null;
      const hasPdf =
        typeof rec.has_pdf === 'boolean'
          ? rec.has_pdf
          : typeof rec.hasPdf === 'boolean'
            ? rec.hasPdf
            : Boolean(fileId);
      const indexed =
        typeof rec.indexed === 'boolean' ? rec.indexed : false;

      enriched.push({
        kind,
        title,
        source_id: sourceId,
        source_type: sourceType,
        item_id: itemId,
        file_id: fileId,
        has_pdf: hasPdf,
        indexed,
      });
    }

    for (const rawDocId of documentIds) {
      const docId = readTrimmedString(rawDocId);
      if (!docId) continue;
      const info = itemInfoMap.get(docId);
      if (!info) continue;
      const alreadyIncluded = enriched.some(
        (s) =>
          s.item_id === info.itemId ||
          (info.ragDocId && s.source_id === info.ragDocId) ||
          (info.fileId && s.file_id === info.fileId),
      );
      if (!alreadyIncluded) {
        enriched.push({
          kind: 'paper',
          title: info.title,
          source_id: info.ragDocId || info.fileId,
          source_type: 'file',
          item_id: info.itemId,
          file_id: info.fileId,
          has_pdf: info.hasPdf,
          indexed: Boolean(info.ragDocId),
        });
      }
    }

    const deduped: EnrichedAttachedSource[] = [];
    const seenKeys = new Set<string>();
    for (const item of enriched) {
      const key = `${item.kind}:${item.item_id ?? ''}:${item.file_id ?? ''}:${item.source_id ?? ''}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      deduped.push(item);
    }
    return deduped;
  }
}
