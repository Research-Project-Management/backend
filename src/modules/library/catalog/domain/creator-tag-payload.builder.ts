import { Prisma, LinkMode, AttachmentType, TagType } from '@prisma/client';
import { PrismaService } from '@/core';
import {
  normalizeTags,
  cleanSingleTag,
  buildTipTapDocFromText,
  parseCreatorString,
  splitAuthorString,
  isNoiseAuthorName,
  resolveCanonicalCreatorRole,
} from '@/modules/library/core';
import { TagInput } from '@/modules/library/catalog/types/tags.types';
import { CreatorCreditInput } from '@/modules/library/catalog/types/items.types';
import { getFileContentPath } from '@/modules/storage/storage.port';
import { isUuid, convertHtmlToMarkdown } from './command-payload.builder';

export function prepareNotesToCreate(
  notes: unknown,
  userId: string,
  createdById: string,
  existingNotesList?: unknown,
) {
  if (!Array.isArray(notes)) return [];

  const existingNotesArr = (
    Array.isArray(existingNotesList) ? existingNotesList : []
  ) as Array<{ contentMd?: string }>;
  const seen = new Set(
    existingNotesArr
      .map((n) => (typeof n.contentMd === 'string' ? n.contentMd.trim() : ''))
      .filter(Boolean),
  );

  return notes
    .map((note) => {
      const noteObj =
        typeof note === 'object' && note !== null
          ? (note as Record<string, unknown>)
          : null;
      const rawContent =
        typeof note === 'string'
          ? note
          : (noteObj?.content ?? noteObj?.contentMd ?? noteObj?.note ?? '');
      const rawStr = typeof rawContent === 'string' ? rawContent : '';
      const contentMd = /<\/?[a-z][\s\S]*>/i.test(rawStr)
        ? convertHtmlToMarkdown(rawStr)
        : rawStr.trim();
      if (!contentMd || seen.has(contentMd)) return null;
      seen.add(contentMd);

      const sourceName =
        typeof noteObj?.source === 'string' ? noteObj.source.trim() : '';
      const isComment = contentMd.toLowerCase().startsWith('comment:');

      let noteTitle =
        typeof noteObj?.title === 'string' ? noteObj.title.trim() : '';
      if (!noteTitle) {
        const firstLine =
          contentMd
            .split(/\r?\n/)
            .find((l) => l.trim().length > 0)
            ?.replace(/^#+\s*/, '')
            .replace(/^>\s*/, '')
            .trim() || '';
        if (firstLine) {
          noteTitle =
            firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77)}...`;
        } else {
          const baseLabel = isComment ? 'Comment' : 'Imported Note';
          noteTitle = sourceName ? `${baseLabel} (${sourceName})` : baseLabel;
        }
      }

      const contentJson =
        noteObj?.contentJson &&
        typeof noteObj.contentJson === 'object' &&
        'type' in (noteObj.contentJson as Record<string, unknown>)
          ? (noteObj.contentJson as Record<string, unknown>)
          : buildTipTapDocFromText(contentMd);

      const customTags = Array.isArray(noteObj?.tags)
        ? (noteObj.tags as unknown[]).filter(
            (t): t is string => typeof t === 'string' && t.trim().length > 0,
          )
        : [];

      const baseTags = normalizeTags([
        'imported',
        ...(sourceName ? [sourceName] : []),
        ...(isComment ? ['comment'] : []),
      ]);
      const mergedTags = Array.from(
        new Set([...baseTags, ...customTags.map((t) => t.trim())]),
      );

      return {
        userId,
        createdById: createdById || userId,
        title: noteTitle,
        contentMd,
        contentJson: contentJson as Prisma.InputJsonValue,
        tags: mergedTags,
        version: 1,
      };
    })
    .filter((n): n is NonNullable<typeof n> => n !== null);
}

export function prepareAttachmentsToCreate(
  attachments: unknown,
  fallbackFileId?: string | null,
  fallbackData?: {
    filename?: string;
    fileUrl?: string;
    size?: number;
    mimeType?: string;
  },
): Prisma.AttachmentCreateWithoutItemInput[] {
  const result: Prisma.AttachmentCreateWithoutItemInput[] = [];

  if (Array.isArray(attachments) && attachments.length > 0) {
    let hasPrimaryPdf = false;

    for (const rawAtt of attachments) {
      if (!rawAtt || typeof rawAtt !== 'object') continue;
      const att = rawAtt as Record<string, unknown>;
      const rawFileId = att.fileId || null;
      const resolvedFileId = rawFileId && isUuid(rawFileId) ? rawFileId : null;

      const title =
        (typeof att.title === 'string' && att.title.trim()) ||
        (typeof att.name === 'string' && att.name.trim()) ||
        '';
      const rawFilename =
        typeof att.filename === 'string' && att.filename.trim()
          ? att.filename.trim()
          : '';
      const filename =
        rawFilename ||
        (title
          ? title.toLowerCase().endsWith('.pdf')
            ? title
            : `${title}.pdf`
          : 'document.pdf');

      const mimeType =
        (typeof att.mimeType === 'string' && att.mimeType.trim()) ||
        (typeof att.contentType === 'string' && att.contentType.trim()) ||
        'application/pdf';
      const size = typeof att.size === 'number' ? att.size : 0;
      const fileUrl =
        typeof att.url === 'string' && att.url.trim()
          ? att.url.trim()
          : resolvedFileId
            ? getFileContentPath(resolvedFileId)
            : '';

      const isPdf =
        mimeType === 'application/pdf' ||
        filename.toLowerCase().endsWith('.pdf');
      let attachmentType: AttachmentType | undefined =
        (att.attachmentType as AttachmentType) ||
        (att.type as AttachmentType | undefined);
      if (!attachmentType) {
        if (!hasPrimaryPdf && isPdf) {
          attachmentType = AttachmentType.primary_pdf;
          hasPrimaryPdf = true;
        } else if (
          mimeType.includes('html') ||
          filename.toLowerCase().endsWith('.html')
        ) {
          attachmentType = AttachmentType.snapshot;
        } else {
          attachmentType = AttachmentType.supplementary;
        }
      } else if (attachmentType === AttachmentType.primary_pdf) {
        hasPrimaryPdf = true;
      }

      const linkMode: LinkMode =
        (att.linkMode as LinkMode | undefined) ||
        (resolvedFileId
          ? LinkMode.imported_file
          : fileUrl.startsWith('http')
            ? attachmentType === AttachmentType.snapshot
              ? LinkMode.imported_url
              : LinkMode.linked_url
            : LinkMode.imported_file);

      const metadata: Record<string, unknown> = {
        ...(typeof att.metadata === 'object' && att.metadata !== null
          ? (att.metadata as Record<string, unknown>)
          : {}),
        ...(title ? { title } : {}),
        ...(att.accessDate ? { accessDate: att.accessDate } : {}),
      };

      result.push({
        filename,
        url: fileUrl,
        fileId: resolvedFileId,
        size,
        mimeType,
        linkMode,
        attachmentType,
        metadata:
          Object.keys(metadata).length > 0
            ? (metadata as Prisma.InputJsonValue)
            : undefined,
        ...(fileUrl || resolvedFileId
          ? {
              revisions: {
                create: [
                  {
                    revisionNumber: 1,
                    url: fileUrl,
                    sizeBytes: size,
                    fileHash: (att.fileHash as string) || '',
                  },
                ],
              },
            }
          : {}),
      });
    }
  }

  if (result.length === 0 && (fallbackData?.fileUrl || fallbackFileId)) {
    const fileUrl =
      fallbackData?.fileUrl ||
      (fallbackFileId ? getFileContentPath(fallbackFileId) : '');
    const filename = fallbackData?.filename || 'document.pdf';
    const mimeType = fallbackData?.mimeType || 'application/pdf';
    const size = fallbackData?.size || 0;

    result.push({
      filename,
      url: fileUrl,
      fileId: fallbackFileId || null,
      size,
      mimeType,
      linkMode: 'imported_file',
      attachmentType: 'primary_pdf',
      revisions: {
        create: [
          {
            revisionNumber: 1,
            url: fileUrl,
            sizeBytes: size,
            fileHash: '',
          },
        ],
      },
    });
  }

  return result;
}

export interface ResolvedTag {
  id: string;
  type: TagType;
}

export function buildTagTypeMap(
  rawTagList: (TagInput | null | undefined)[],
): Map<string, TagType> {
  const tagTypeMap = new Map<string, TagType>();
  if (!Array.isArray(rawTagList)) return tagTypeMap;
  for (const rt of rawTagList) {
    if (typeof rt === 'object' && rt !== null) {
      const tagName = (rt.name || rt.tag || '').trim();
      if (!tagName) continue;
      const typeVal =
        'type' in rt ? (rt as { type?: unknown }).type : undefined;
      let resolvedType: TagType | undefined;
      if (
        typeVal === 1 ||
        typeVal === 'automatic' ||
        typeVal === TagType.automatic
      ) {
        resolvedType = TagType.automatic;
      } else if (
        typeVal === 0 ||
        typeVal === 'manual' ||
        typeVal === TagType.manual
      ) {
        resolvedType = TagType.manual;
      }
      if (resolvedType) {
        tagTypeMap.set(tagName.toLowerCase(), resolvedType);
        const normalized = cleanSingleTag(tagName);
        if (normalized) {
          tagTypeMap.set(normalized.toLowerCase(), resolvedType);
        }
      }
    }
  }
  return tagTypeMap;
}

export async function resolveOrCreateTags(
  client: Prisma.TransactionClient | PrismaService,
  userId: string,
  rawTagList: (TagInput | null | undefined)[],
  defaultTagType: TagType = TagType.manual,
  projectId?: string | null,
): Promise<ResolvedTag[]> {
  const normalizedTagNames = normalizeTags(rawTagList).slice(0, 30);
  if (normalizedTagNames.length === 0) return [];

  const effectiveProjectId =
    projectId &&
    projectId !== 'user' &&
    projectId !== 'me' &&
    projectId !== 'personal' &&
    isUuid(projectId)
      ? projectId
      : null;

  const scopeWhere: Prisma.TagWhereInput = effectiveProjectId
    ? { projectId: effectiveProjectId }
    : { userId, projectId: null };

  const tagTypeMap = buildTagTypeMap(rawTagList);

  const preExistingTags =
    (await client.tag.findMany({
      where: {
        ...scopeWhere,
        OR: normalizedTagNames.map((name) => ({
          name: { equals: name, mode: 'insensitive' as const },
        })),
      },
      select: { id: true, name: true, type: true },
    })) || [];

  const existingLowerNames = new Set(
    preExistingTags
      .map((t: { id: string; name?: string }) =>
        typeof t.name === 'string' ? t.name.toLowerCase() : '',
      )
      .filter(Boolean),
  );
  const missingTagNames = normalizedTagNames.filter(
    (name) => !existingLowerNames.has(name.toLowerCase()),
  );

  if (missingTagNames.length > 0) {
    await client.tag.createMany({
      data: missingTagNames.map((name) => ({
        userId,
        createdById: userId,
        name,
        type: tagTypeMap.get(name.toLowerCase()) || defaultTagType,
        projectId: effectiveProjectId,
      })),
      skipDuplicates: true,
    });
  }

  const allMatchingTags =
    missingTagNames.length > 0
      ? (await client.tag.findMany({
          where: {
            ...scopeWhere,
            OR: normalizedTagNames.map((name) => ({
              name: { equals: name, mode: 'insensitive' as const },
            })),
          },
          select: { id: true, name: true, type: true },
        })) || preExistingTags
      : preExistingTags;

  const dedupedByLower = new Map<string, ResolvedTag>();
  for (const t of allMatchingTags as Array<{
    id: string;
    name?: string;
    type?: TagType;
  }>) {
    const key = typeof t.name === 'string' ? t.name.toLowerCase() : t.id;
    if (!dedupedByLower.has(key)) {
      dedupedByLower.set(key, {
        id: t.id,
        type: tagTypeMap.get(key) || t.type || defaultTagType,
      });
    }
  }

  return Array.from(dedupedByLower.values());
}

export async function syncTagsForCatalogItem(
  client: Prisma.TransactionClient | PrismaService,
  userId: string,
  itemId: string,
  rawTags: (TagInput | null | undefined)[],
  defaultTagType: TagType = TagType.manual,
  projectId?: string | null,
): Promise<void> {
  const normalizedTagsList = normalizeTags(rawTags);
  if (normalizedTagsList.length === 0) {
    await client.itemTag.deleteMany({ where: { itemId } });
    return;
  }

  const resolvedTags = await resolveOrCreateTags(
    client,
    userId,
    rawTags,
    defaultTagType,
    projectId,
  );
  if (resolvedTags.length === 0) {
    await client.itemTag.deleteMany({ where: { itemId } });
    return;
  }

  await client.itemTag.deleteMany({
    where: {
      itemId,
      tagId: { notIn: resolvedTags.map((t) => t.id) },
    },
  });

  await client.itemTag.createMany({
    data: resolvedTags.map((t) => ({
      tagId: t.id,
      itemId,
      type: t.type,
    })),
    skipDuplicates: true,
  });
}

export function deriveFirstAuthor(data: {
  contributors?: Array<Record<string, unknown> | CreatorCreditInput>;
  creators?: Array<Record<string, unknown> | CreatorCreditInput>;
  authors?: Array<string | Record<string, unknown>>;
}): string | null {
  const structured =
    data.contributors && data.contributors.length > 0
      ? data.contributors
      : data.creators && data.creators.length > 0
        ? data.creators
        : null;
  if (structured) {
    const c0 = structured[0] as Record<string, unknown>;
    const authorName =
      (c0.lastName as string) ||
      (c0.fullName as string) ||
      (c0.name as string) ||
      '';
    if (!authorName) return null;
    return structured.length > 1 ? `${authorName} et al.` : authorName;
  }
  if (data.authors && data.authors.length > 0) {
    const firstAuthor = data.authors[0] as
      | string
      | { name?: string; fullName?: string; lastName?: string }
      | undefined;
    const authorStr: string =
      typeof firstAuthor === 'string'
        ? firstAuthor
        : firstAuthor?.name ||
          firstAuthor?.fullName ||
          firstAuthor?.lastName ||
          '';
    const parsed0 = parseCreatorString(authorStr, 0);
    const authorName = parsed0.lastName || parsed0.fullName;
    if (!authorName) return null;
    return data.authors.length > 1 ? `${authorName} et al.` : authorName;
  }
  return null;
}

export function prepareContributorsToCreate(
  data: {
    contributors?: CreatorCreditInput[];
    creators?: CreatorCreditInput[];
    authors?: string[];
  },
  itemType?: string,
): Array<{
  creatorType: string;
  fieldMode?: number;
  firstName: string;
  lastName: string;
  fullName: string;
  shortName?: string;
  orderIndex: number;
}> | null {
  const structuredList =
    data.contributors !== undefined
      ? data.contributors
      : data.creators !== undefined
        ? data.creators
        : undefined;

  if (structuredList !== undefined) {
    return (structuredList || [])
      .filter((c: CreatorCreditInput) => {
        const fullName =
          c.fullName ||
          [c.firstName, c.lastName].filter(Boolean).join(' ') ||
          c.name ||
          '';
        return Boolean(fullName && !isNoiseAuthorName(fullName));
      })
      .map((c: CreatorCreditInput, index: number) => {
        const fullName =
          c.fullName ||
          [c.firstName, c.lastName].filter(Boolean).join(' ') ||
          c.name ||
          '';
        let first = c.firstName || '';
        let last = c.lastName || '';
        if (!first && !last && fullName) {
          const parsed = parseCreatorString(fullName, index);
          first = parsed.firstName;
          last = parsed.lastName;
        }
        return {
          creatorType: resolveCanonicalCreatorRole(c.creatorType, { itemType }),
          fieldMode: c.fieldMode !== undefined ? Number(c.fieldMode) : 0,
          firstName: first,
          lastName: last,
          fullName,
          shortName: c.shortName || '',
          orderIndex: c.orderIndex !== undefined ? c.orderIndex : index,
        };
      });
  }

  if (data.authors !== undefined) {
    return (data.authors || [])
      .flatMap((authorName: string) => splitAuthorString(authorName))
      .map((authorName: string, index: number) => {
        const parsed = parseCreatorString(authorName, index);
        return {
          creatorType: parsed.creatorType,
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          fullName: parsed.fullName,
          orderIndex: parsed.orderIndex,
        };
      });
  }

  return null;
}
