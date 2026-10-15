import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import { Prisma } from '@prisma/client';
import {
  USER_MINIMAL_SELECT,
  mapUserMinimal,
  UserProfileSource,
} from '@/modules/work-item/common/types/shared.types';

function mapCommentAuthor<T extends { author?: UserProfileSource | null }>(
  comment: T | null,
) {
  if (!comment) return null;
  return {
    ...comment,
    author: comment.author ? mapUserMinimal(comment.author) : comment.author,
  };
}

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
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: USER_MINIMAL_SELECT,
    });
    return mapUserMinimal(user);
  }

  async findWorkItemComments(workItemId: string) {
    const itemUuid = await this.resolveWorkItemUuid(workItemId);
    if (!itemUuid) return [];
    const comments = await this.prismaService.workItemComment.findMany({
      where: { workItemId: itemUuid },
      orderBy: { createdAt: 'asc' },
      include: {
        author: { select: USER_MINIMAL_SELECT },
      },
    });
    return comments.map((c) => mapCommentAuthor(c));
  }

  async findCommentById(commentId: string) {
    const comment = await this.prismaService.workItemComment.findUnique({
      where: { id: commentId },
      include: {
        author: { select: USER_MINIMAL_SELECT },
      },
    });
    return mapCommentAuthor(comment);
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
    attachments?: Prisma.InputJsonValue;
  }) {
    const itemUuid = await this.resolveWorkItemUuid(data.workItemId);
    if (!itemUuid) {
      throw new NotFoundException(`Work item "${data.workItemId}" not found`);
    }
    const comment = await this.prismaService.workItemComment.create({
      data: {
        workItemId: itemUuid,
        authorId: data.authorId,
        content: data.content,
        attachments: data.attachments ?? [],
      },
      include: {
        author: { select: USER_MINIMAL_SELECT },
      },
    });
    return mapCommentAuthor(comment)!;
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
    const comment = await this.prismaService.workItemComment.update({
      where: { id: commentId },
      data,
      include: {
        author: { select: USER_MINIMAL_SELECT },
      },
    });
    return mapCommentAuthor(comment)!;
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
