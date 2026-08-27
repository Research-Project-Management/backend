import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma } from '@prisma/client';

const AUTHOR_SELECT = {
  id: true,
  name: true,
  avatar: true,
  email: true,
} as const;

@Injectable()
export class TaskCommentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAuthorById(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: AUTHOR_SELECT,
    });
  }

  async findTaskComments(taskId: string) {
    return this.prisma.taskComment.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
      include: {
        author: { select: AUTHOR_SELECT },
      },
    });
  }

  async findTaskCommentById(commentId: string) {
    return this.prisma.taskComment.findUnique({
      where: { id: commentId },
      include: {
        author: { select: AUTHOR_SELECT },
      },
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
      },
      include: {
        author: { select: AUTHOR_SELECT },
      },
    });
  }

  async updateTaskComment(
    commentId: string,
    data: {
      content?: string;
      isEdited?: boolean;
      reactions?: Prisma.InputJsonValue;
      replies?: Prisma.InputJsonValue;
    },
  ) {
    return this.prisma.taskComment.update({
      where: { id: commentId },
      data,
      include: {
        author: { select: AUTHOR_SELECT },
      },
    });
  }

  async deleteTaskComment(commentId: string) {
    return this.prisma.taskComment.delete({
      where: { id: commentId },
    });
  }
}
