import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma } from '@prisma/client';
import { isUuid } from '@/core/utils/uuid.util';

const AUTHOR_SELECT = {
  id: true,
  name: true,
  avatar: true,
  email: true,
} as const;

@Injectable()
export class CommentRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async resolveWorkItemUuid(
    workItemIdOrIdentifier: string,
  ): Promise<string | null> {
    if (isUuid(workItemIdOrIdentifier)) {
      return workItemIdOrIdentifier;
    }
    const item = await this.prismaService.workItem.findFirst({
      where: {
        identifier: { equals: workItemIdOrIdentifier, mode: 'insensitive' },
        deletedAt: null,
      },
      select: { id: true },
    });
    return item?.id || null;
  }

  async findAuthorById(userId: string) {
    return this.prismaService.user.findUnique({
      where: { id: userId },
      select: AUTHOR_SELECT,
    });
  }

  async findWorkItemComments(workItemId: string) {
    const itemUuid = await this.resolveWorkItemUuid(workItemId);
    if (!itemUuid) return [];
    return this.prismaService.workItemComment.findMany({
      where: { workItemId: itemUuid },
      orderBy: { createdAt: 'asc' },
      include: {
        author: { select: AUTHOR_SELECT },
      },
    });
  }

  async findCommentById(commentId: string) {
    return this.prismaService.workItemComment.findUnique({
      where: { id: commentId },
      include: {
        author: { select: AUTHOR_SELECT },
      },
    });
  }

  async findCommentWithProject(commentId: string) {
    return this.prismaService.workItemComment.findUnique({
      where: { id: commentId },
      include: {
        workItem: {
          select: {
            projectId: true,
            project: { select: { id: true, createdById: true } },
          },
        },
      },
    });
  }

  async createComment(data: {
    workItemId: string;
    authorId: string;
    content: string;
    attachments?: any;
  }) {
    const itemUuid = await this.resolveWorkItemUuid(data.workItemId);
    if (!itemUuid) {
      throw new Error(`Work item "${data.workItemId}" not found`);
    }
    return this.prismaService.workItemComment.create({
      data: {
        workItemId: itemUuid,
        authorId: data.authorId,
        content: data.content,
        attachments: data.attachments ?? [],
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

  async deleteComment(commentId: string) {
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
