import {
  CommentReply as PrismaCommentReply,
  DocChange,
  DocComment,
  DocReview,
  ReviewRound,
} from '@prisma/client';
import { isUUID } from 'class-validator';
import { CommentReply, CommentThread, TextRange, TrackChange } from '../domain';

const MENTION_TOKEN_REGEX =
  /@\[[^\]]+\]\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;

export function extractMentionUserIds(content: string): string[] {
  const ids = new Set<string>();
  for (const match of content.matchAll(MENTION_TOKEN_REGEX)) {
    const id = match[1];
    if (id && isUUID(id)) {
      ids.add(id.toLowerCase());
    }
  }
  return Array.from(ids);
}

type DocScopeMeta = { spaceId: string; pageId: string } | null;

export type ChangeWithDoc = DocChange & {
  doc?: DocScopeMeta;
  spaceId?: string;
  pageId?: string | null;
};

export type ThreadWithReplies = DocComment & {
  replies?: PrismaCommentReply[];
  doc?: DocScopeMeta;
  spaceId?: string;
  pageId?: string | null;
};

export type DocReviewWithRound = DocReview & {
  rounds?: ReviewRound[];
  doc?: { spaceId: string } | null;
  spaceId?: string;
};

export function toPrismaBytes(
  data?: Uint8Array | null,
): Uint8Array<ArrayBuffer> | null {
  return data && data.length > 0 ? new Uint8Array(data) : null;
}

export type ResolvedUserMap = Map<
  string,
  { id: string; name: string; avatar?: string }
>;

export function decodeAnchorBase64(value?: string | null): Uint8Array | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const buf = Buffer.from(trimmed, 'base64');
  return buf.length > 0 ? new Uint8Array(buf) : null;
}

export function encodeAnchorBase64(value?: Uint8Array | null): string | null {
  if (!value || value.length === 0) return null;
  return Buffer.from(value).toString('base64');
}

export function toCommentDto(
  thread: CommentThread | ThreadWithReplies,
  userMap: ResolvedUserMap,
  options?: { includeAvatar?: boolean; includeDocId?: boolean },
) {
  const creator = thread.createdById
    ? userMap.get(thread.createdById)
    : undefined;
  const includeAvatar = options?.includeAvatar ?? false;
  const includeDocId = options?.includeDocId ?? true;
  const line =
    thread instanceof CommentThread ? thread.range.startLine : thread.startLine;
  const lineEnd =
    thread instanceof CommentThread ? thread.range.endLine : thread.endLine;
  const anchorStart = encodeAnchorBase64(thread.anchorStart);
  const anchorEnd = encodeAnchorBase64(thread.anchorEnd);

  return {
    id: thread.id,
    page: thread.docId,
    projectPageId: thread.docId,
    ...(includeDocId ? { docId: thread.docId } : {}),
    author: {
      id: thread.createdById || 'anonymous',
      name: creator?.name || 'Collaborator',
      ...(includeAvatar ? { avatar: creator?.avatar || '' } : {}),
    },
    content: thread.quote || '',
    line,
    lineEnd,
    ...(anchorStart ? { anchorStart } : {}),
    ...(anchorEnd ? { anchorEnd } : {}),
    ...(thread.baseDocRev != null ? { baseDocRev: thread.baseDocRev } : {}),
    status: thread.isResolved ? 'resolved' : 'open',
    replies: (thread.replies || []).map((r) => {
      const replyUser = r.createdById ? userMap.get(r.createdById) : undefined;
      return {
        id: r.id,
        author: {
          id: r.createdById || 'anonymous',
          name: replyUser?.name || 'Collaborator',
          ...(includeAvatar ? { avatar: replyUser?.avatar || '' } : {}),
        },
        content: r.content,
        createdAt: r.createdAt.toISOString(),
      };
    }),
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

export function toSuggestionDto(
  change: TrackChange | DocChange,
  userMap: ResolvedUserMap,
) {
  const creator = change.createdById
    ? userMap.get(change.createdById)
    : undefined;
  const isEntity = change instanceof TrackChange;
  const startLine = isEntity ? change.range.startLine : (change.startLine ?? 0);
  const startCol = isEntity ? change.range.startCol : change.startCol;
  const endLine = isEntity
    ? change.range.endLine
    : (change.endLine ?? change.startLine ?? 0);
  const endCol = isEntity ? change.range.endCol : change.endCol;
  const anchorStart = encodeAnchorBase64(change.anchorStart);
  const anchorEnd = encodeAnchorBase64(change.anchorEnd);

  return {
    id: change.id,
    ...(change.groupId ? { groupId: change.groupId } : {}),
    pageId: change.docId,
    page: change.docId,
    projectPageId: change.docId,
    authorId: change.createdById || 'anonymous',
    author: {
      id: change.createdById || 'anonymous',
      name: creator?.name || 'Collaborator',
      ...(creator?.avatar ? { avatar: creator.avatar } : {}),
      email: '',
    },
    type: change.type,
    originalText: change.type === 'delete' ? change.text : '',
    suggestedText: change.type === 'insert' ? change.text : '',
    text: change.text,
    fromLine: startLine + 1,
    fromColumn: startCol,
    toLine: endLine + 1,
    toColumn: endCol,
    ...(anchorStart ? { anchorStart } : {}),
    ...(anchorEnd ? { anchorEnd } : {}),
    ...(change.baseDocRev != null ? { baseDocRev: change.baseDocRev } : {}),
    description: null,
    status: change.status,
    resolvedById: change.resolvedById,
    resolvedAt: change.resolvedAt ? change.resolvedAt.toISOString() : null,
    createdAt: change.createdAt.toISOString(),
    updatedAt: change.updatedAt.toISOString(),
  };
}

export class ReviewMapper {
  public static toDomainChange(
    row: ChangeWithDoc,
    fallbackSpaceId = '',
    fallbackPageId: string | null = null,
  ): TrackChange {
    return TrackChange.create({
      id: row.id,
      spaceId: row.doc?.spaceId ?? row.spaceId ?? fallbackSpaceId,
      pageId: row.doc?.pageId ?? row.pageId ?? fallbackPageId,
      docId: row.docId,
      groupId: row.groupId ?? null,
      type: row.type,
      status: row.status,
      text: row.text,
      range: TextRange.create({
        startLine: row.startLine,
        startCol: row.startCol,
        endLine: row.endLine,
        endCol: row.endCol,
      }),
      anchorStart: row.anchorStart ?? null,
      anchorEnd: row.anchorEnd ?? null,
      baseDocRev: row.baseDocRev ?? null,
      createdById: row.createdById,
      resolvedById: row.resolvedById,
      resolvedAt: row.resolvedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  public static toDomainReply(
    row: PrismaCommentReply & { threadId?: string },
  ): CommentReply {
    return CommentReply.create({
      id: row.id,
      threadId: row.commentId ?? row.threadId ?? '',
      content: row.content,
      createdById: row.createdById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  public static toDomainThread(
    row: ThreadWithReplies,
    fallbackSpaceId = '',
    fallbackPageId: string | null = null,
  ): CommentThread {
    const replies = row.replies
      ? row.replies.map((r) => this.toDomainReply(r))
      : [];

    return CommentThread.create({
      id: row.id,
      spaceId: row.doc?.spaceId ?? row.spaceId ?? fallbackSpaceId,
      pageId: row.doc?.pageId ?? row.pageId ?? fallbackPageId,
      docId: row.docId,
      quote: row.quote,
      range: TextRange.create({
        startLine: row.startLine,
        startCol: row.startCol,
        endLine: row.endLine,
        endCol: row.endCol,
      }),
      anchorStart: row.anchorStart ?? null,
      anchorEnd: row.anchorEnd ?? null,
      baseDocRev: row.baseDocRev ?? null,
      isResolved: row.isResolved,
      createdById: row.createdById,
      resolvedById: row.resolvedById,
      resolvedAt: row.resolvedAt,
      replies,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}
