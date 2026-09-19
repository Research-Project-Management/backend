import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { CommentStatus, Prisma } from '@prisma/client';

const AUTHOR_SELECT = {
  id: true,
  name: true,
  avatar: true,
  email: true,
} as const;

@Injectable()
export class CommentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAuthorById(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: AUTHOR_SELECT,
    });
  }

  async findComments(pageId: string) {
    return this.prisma.pageComment.findMany({
      where: {
        OR: [{ pageId }, { projectPageId: pageId }],
      },
      orderBy: { createdAt: 'asc' },
      include: {
        author: { select: AUTHOR_SELECT },
      },
    });
  }

  async findCommentById(commentId: string) {
    return this.prisma.pageComment.findUnique({
      where: { id: commentId },
      include: {
        author: { select: AUTHOR_SELECT },
        page: { select: { id: true, projectId: true } },
      },
    });
  }

  async createComment(data: {
    pageId: string;
    projectPageId?: string | null;
    authorId: string;
    content: string;
    status?: CommentStatus;
    line?: number;
    lineEnd?: number;
  }) {
    return this.prisma.pageComment.create({
      data: {
        pageId: data.pageId,
        projectPageId: data.projectPageId || null,
        authorId: data.authorId,
        content: data.content,
        status: data.status || CommentStatus.open,
        line: data.line,
        lineEnd: data.lineEnd,
      },
      include: {
        author: { select: AUTHOR_SELECT },
      },
    });
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
    return this.prisma.pageComment.update({
      where: { id: commentId },
      data,
      include: {
        author: { select: AUTHOR_SELECT },
      },
    });
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
