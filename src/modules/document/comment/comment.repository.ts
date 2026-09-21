import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { CommentStatus, Prisma } from '@prisma/client';

const AUTHOR_SELECT = {
  id: true,
  email: true,
  profile: {
    select: {
      name: true,
      avatar: true,
    },
  },
} as const;

function mapCommentAuthor<T extends { author?: any }>(comment: T | null): any {
  if (!comment) return null;
  const author = comment.author
    ? {
        id: comment.author.id,
        email: comment.author.email,
        name: comment.author.profile?.name ?? comment.author.name ?? 'User',
        avatar: comment.author.profile?.avatar ?? comment.author.avatar ?? null,
      }
    : comment.author;
  return {
    ...comment,
    author,
  };
}

@Injectable()
export class CommentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAuthorById(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: AUTHOR_SELECT,
    });
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      name: user.profile?.name ?? 'User',
      avatar: user.profile?.avatar ?? null,
    };
  }

  async findComments(pageId: string) {
    const comments = await this.prisma.pageComment.findMany({
      where: {
        OR: [{ pageId }, { projectPageId: pageId }],
      },
      orderBy: { createdAt: 'asc' },
      include: {
        author: { select: AUTHOR_SELECT },
      },
    });
    return comments.map((c) => mapCommentAuthor(c));
  }

  async findCommentById(commentId: string) {
    const comment = await this.prisma.pageComment.findUnique({
      where: { id: commentId },
      include: {
        author: { select: AUTHOR_SELECT },
        page: { select: { id: true, projectId: true, title: true } },
      },
    });
    return mapCommentAuthor(comment);
  }

  async createComment(data: {
    pageId: string;
    projectPageId?: string | null;
    authorId: string;
    content: string;
    status?: CommentStatus;
    line?: number;
    lineEnd?: number;
    yjsAnchorStart?: string | null;
    yjsAnchorEnd?: string | null;
    selectedText?: string | null;
  }) {
    const comment = await this.prisma.pageComment.create({
      data: {
        pageId: data.pageId,
        projectPageId: data.projectPageId || null,
        authorId: data.authorId,
        content: data.content,
        status: data.status || CommentStatus.open,
        line: data.line,
        lineEnd: data.lineEnd,
        yjsAnchorStart: data.yjsAnchorStart || null,
        yjsAnchorEnd: data.yjsAnchorEnd || null,
        selectedText: data.selectedText || null,
      },
      include: {
        author: { select: AUTHOR_SELECT },
      },
    });
    return mapCommentAuthor(comment);
  }

  async updateComment(
    commentId: string,
    data: {
      content?: string;
      status?: CommentStatus;
      isEdited?: boolean;
      replies?: Prisma.InputJsonValue;
    },
  ) {
    const comment = await this.prisma.pageComment.update({
      where: { id: commentId },
      data,
      include: {
        author: { select: AUTHOR_SELECT },
      },
    });
    return mapCommentAuthor(comment);
  }

  async deleteComment(commentId: string) {
    return this.prisma.pageComment.delete({
      where: { id: commentId },
    });
  }

  // Backward-compatible aliases
  findPageComments = this.findComments.bind(this);
  findPageCommentById = this.findCommentById.bind(this);
  createPageComment = this.createComment.bind(this);
  updatePageComment = this.updateComment.bind(this);
  deletePageComment = this.deleteComment.bind(this);
}

export const PageCommentRepository = CommentRepository;
export type PageCommentRepository = CommentRepository;
