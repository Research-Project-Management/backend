import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { CommentStatus, Prisma } from '@prisma/client';

const AUTHOR_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

@Injectable()
export class CommentRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Author / User ──────────────────────────────────────────────────────────

  async findAuthorById(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: AUTHOR_SELECT,
    });
  }

  // ── Page Comments ──────────────────────────────────────────────────────────

  async findPageComments(pageId: string) {
    return this.prisma.pageComment.findMany({
      where: { pageId },
      include: { author: { select: AUTHOR_SELECT } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findPageCommentById(commentId: string) {
    return this.prisma.pageComment.findUnique({
      where: { id: commentId },
    });
  }

  async createPageComment(data: {
    pageId: string;
    authorId: string;
    content: string;
    status: CommentStatus;
    line?: number | null;
    lineEnd?: number | null;
  }) {
    return this.prisma.pageComment.create({
      data: {
        pageId: data.pageId,
        authorId: data.authorId,
        content: data.content,
        status: data.status,
        line: data.line ?? null,
        lineEnd: data.lineEnd ?? null,
        replies: [],
      },
      include: { author: { select: AUTHOR_SELECT } },
    });
  }

  async updatePageComment(
    commentId: string,
    data: Prisma.PageCommentUpdateInput,
  ) {
    return this.prisma.pageComment.update({
      where: { id: commentId },
      data,
      include: { author: { select: AUTHOR_SELECT } },
    });
  }

  async deletePageComment(commentId: string) {
    return this.prisma.pageComment.delete({
      where: { id: commentId },
    });
  }

  // ── Task Comments ──────────────────────────────────────────────────────────

  async findTaskComments(taskId: string) {
    return this.prisma.taskComment.findMany({
      where: { taskId },
      include: { author: { select: AUTHOR_SELECT } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async countTaskComments(taskId: string) {
    return this.prisma.taskComment.count({
      where: { taskId },
    });
  }

  async findTaskCommentById(commentId: string) {
    return this.prisma.taskComment.findUnique({
      where: { id: commentId },
    });
  }

  async createTaskComment(data: {
    taskId: string;
    authorId: string;
    content: string;
  }) {
    return this.prisma.taskComment.create({
      data: {
        taskId: data.taskId,
        authorId: data.authorId,
        content: data.content,
        reactions: [],
        replies: [],
      },
      include: { author: { select: AUTHOR_SELECT } },
    });
  }

  async updateTaskComment(
    commentId: string,
    data: Prisma.TaskCommentUpdateInput,
  ) {
    return this.prisma.taskComment.update({
      where: { id: commentId },
      data,
      include: { author: { select: AUTHOR_SELECT } },
    });
  }

  async deleteTaskComment(commentId: string) {
    return this.prisma.taskComment.delete({
      where: { id: commentId },
    });
  }
}
