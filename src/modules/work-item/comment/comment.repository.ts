import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import { Prisma } from '@prisma/client';
import {
  USER_MINIMAL_SELECT,
  mapUserMinimal,
  UserProfileSource,
  resolveWorkItemUuid as resolveSharedWorkItemUuid,
} from '@/modules/work-item/common/types/shared.types';

function mapCommentAuthor<
  T extends { createdBy?: UserProfileSource | null; createdById: string },
>(comment: T | null) {
  if (!comment) return null;
  const { createdBy, ...rest } = comment;
  return {
    ...rest,
    authorId: comment.createdById,
    author: createdBy ? mapUserMinimal(createdBy) : null,
  };
}

@Injectable()
export class CommentRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async resolveWorkItemUuid(
    workItemIdOrIdentifier: string,
  ): Promise<string | null> {
    return resolveSharedWorkItemUuid(
      this.prismaService,
      workItemIdOrIdentifier,
    );
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
        createdBy: { select: USER_MINIMAL_SELECT },
      },
    });
    return comments.map((c) => mapCommentAuthor(c));
  }

  async findCommentById(commentId: string) {
    const comment = await this.prismaService.workItemComment.findUnique({
      where: { id: commentId },
      include: {
        createdBy: { select: USER_MINIMAL_SELECT },
      },
    });
    return mapCommentAuthor(comment);
  }

  async findCommentWithProject(commentId: string) {
    const comment = await this.prismaService.workItemComment.findUnique({
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
    if (!comment) return null;
    return {
      ...comment,
      authorId: comment.createdById,
    };
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
        createdById: data.authorId,
        content: data.content,
        attachments: data.attachments ?? [],
      },
      include: {
        createdBy: { select: USER_MINIMAL_SELECT },
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
        createdBy: { select: USER_MINIMAL_SELECT },
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
