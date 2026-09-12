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
    return this.prismaService.taskComment.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
      include: {
        author: { select: AUTHOR_SELECT },
      },
    });
  }

  async findTaskCommentById(commentId: string) {
    return this.prismaService.taskComment.findUnique({
      where: { id: commentId },
      include: {
        author: { select: AUTHOR_SELECT },
      },
    });
  }

  async findTaskCommentWithProject(commentId: string) {
    return this.prismaService.taskComment.findUnique({
      where: { id: commentId },
      include: {
        task: {
          select: {
            projectId: true,
            project: { select: { workspaceId: true } },
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
    return this.prismaService.taskComment.create({
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
    return this.prismaService.taskComment.update({
      where: { id: commentId },
      data,
      include: {
        author: { select: AUTHOR_SELECT },
      },
    });
  }

  async deleteTaskComment(commentId: string) {
    return this.prismaService.taskComment.delete({
      where: { id: commentId },
    });
  }

  async findWorkspaceMemberRole(
    workspaceId: string,
    userId: string,
  ): Promise<string | null> {
    const member = await this.prismaService.workspaceMember.findFirst({
      where: { workspaceId, userId },
      select: { role: true },
    });
    return member?.role ?? null;
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

export const CommentRepository = TaskCommentRepository;
export type CommentRepository = TaskCommentRepository;
