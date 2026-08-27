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
export class PageCommentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAuthorById(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: AUTHOR_SELECT,
    });
  }

  async findPageComments(pageId: string) {
    return this.prisma.pageComment.findMany({
      where: { pageId },
      orderBy: { createdAt: 'asc' },
      include: {
        author: { select: AUTHOR_SELECT },
      },
    });
  }

  async findPageCommentById(commentId: string) {
    return this.prisma.pageComment.findUnique({
      where: { id: commentId },
      include: {
        author: { select: AUTHOR_SELECT },
      },
    });
  }

  async createPageComment(data: {
    pageId: string;
    authorId: string;
    content: string;
    status?: CommentStatus;
    line?: number;
    lineEnd?: number;
  }) {
    return this.prisma.pageComment.create({
      data: {
        pageId: data.pageId,
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

  async updatePageComment(
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

  async deletePageComment(commentId: string) {
    return this.prisma.pageComment.delete({
      where: { id: commentId },
    });
  }
}
