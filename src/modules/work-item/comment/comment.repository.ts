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
  constructor(private readonly prismaService: PrismaService) {}

  async findAuthorById(userId: string) {
    return this.prismaService.user.findUnique({
      where: { id: userId },
      select: AUTHOR_SELECT,
    });
  }

  async findTaskComments(taskId: string) {
    return this.prismaService.workItemComment.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
      include: {
        author: { select: AUTHOR_SELECT },
      },
    });
  }

  async findTaskCommentById(commentId: string) {
    return this.prismaService.workItemComment.findUnique({
      where: { id: commentId },
      include: {
        author: { select: AUTHOR_SELECT },
      },
    });
  }

  async findTaskCommentWithProject(commentId: string) {
    return this.prismaService.workItemComment.findUnique({
      where: { id: commentId },
      include: {
        task: {
          select: {
            projectId: true,
            project: { select: { id: true, createdById: true } },
          },
        },
      },
    });
  }

  async createTaskComment(data: {
    taskId: string;
    authorId: string;
    content: string;
    attachments?: any;
  }) {
    return this.prismaService.workItemComment.create({
      data: {
        taskId: data.taskId,
        authorId: data.authorId,
        content: data.content,
        attachments: data.attachments ?? [],
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
      attachments?: Prisma.InputJsonValue;
    },
  ) {
    return this.prismaService.workItemComment.update({
      where: { id: commentId },
      data,
      include: {
        author: { select: AUTHOR_SELECT },
      },
    });
  }

  async deleteTaskComment(commentId: string) {
    return this.prismaService.workItemComment.delete({
      where: { id: commentId },
    });
  }

  async findProjectMemberRole(
    projectId: string,
    userId: string,
  ): Promise<string | null> {
    const member = await this.prismaService.projectMember.findUnique({
      where: {
        projectId_userId: { projectId, userId },
      },
      select: { role: true },
    });
    return member?.role ?? null;
  }
}
