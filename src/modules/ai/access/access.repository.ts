import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { resolveDecryptedLlmOverride } from '@/modules/identity/user/utils/user.util';
import { isValidUuid } from './domain/scope.mapper';
import type {
  ChatOwnershipRecord,
  LlmOverridePayload,
  PageLookupRecord,
  SpaceRecord,
  UserProfileContext,
} from './types/access.type';

@Injectable()
export class AccessRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findPersonalSpace(userId: string): Promise<{ id: string } | null> {
    if (!this.prisma.space?.findFirst) return null;
    return this.prisma.space
      .findFirst({
        where: {
          OR: [{ id: userId }, { ownerUserId: userId, type: 'personal' }],
        },
        select: { id: true },
      })
      .catch(() => null);
  }

  async findSpaceByIdOrProjectId(alias: string): Promise<SpaceRecord | null> {
    if (!this.prisma.space?.findFirst || !isValidUuid(alias)) return null;
    return this.prisma.space
      .findFirst({
        where: { OR: [{ id: alias }, { projectId: alias }] },
        select: {
          id: true,
          type: true,
          ownerUserId: true,
          projectId: true,
        },
      })
      .catch(() => null);
  }

  async findAccessibleProject(
    aliasOrId: string,
    userId: string,
  ): Promise<{ id: string; spaceId: string | null } | null> {
    if (!this.prisma.project?.findFirst) return null;
    const isUuid = isValidUuid(aliasOrId);
    const project = await this.prisma.project
      .findFirst({
        where: {
          OR: [
            ...(isUuid ? [{ id: aliasOrId }] : []),
            { identifier: aliasOrId },
          ],
          deletedAt: null,
          AND: [
            {
              OR: [{ createdById: userId }, { members: { some: { userId } } }],
            },
          ],
        },
        select: {
          id: true,
          space: { select: { id: true } },
        },
      })
      .catch(() => null);

    if (!project) return null;
    return {
      id: project.id,
      spaceId: project.space?.id ?? null,
    };
  }

  async findChatOwnership(chatId: string): Promise<ChatOwnershipRecord | null> {
    if (!this.prisma.aiChat?.findFirst) return null;
    const chat = await this.prisma.aiChat
      .findFirst({
        where: { id: chatId },
        select: { id: true, createdById: true, spaceId: true, title: true },
      })
      .catch(() => null);
    if (!chat) return null;
    return {
      id: chat.id,
      createdById: chat.createdById,
      spaceId: chat.spaceId,
      title: chat.title ?? 'New Chat',
    };
  }

  hasPageLookup(): boolean {
    return Boolean(this.prisma.page || this.prisma.pageDoc);
  }

  async findPageOrDoc(pageId: string): Promise<PageLookupRecord | null> {
    const page = this.prisma.page?.findFirst
      ? await this.prisma.page
          .findFirst({
            where: { id: pageId, deletedAt: null },
            select: { id: true, title: true, spaceId: true },
          })
          .catch(() => null)
      : null;

    if (page) {
      return {
        canonicalPageId: page.id,
        spaceId: page.spaceId,
        titleHint: page.title ?? null,
      };
    }

    const doc = this.prisma.pageDoc?.findFirst
      ? await this.prisma.pageDoc
          .findFirst({
            where: { id: pageId, deletedAt: null },
            select: {
              id: true,
              pageId: true,
              spaceId: true,
              lastKnownPath: true,
              node: { select: { path: true } },
            },
          })
          .catch(() => null)
      : null;

    if (!doc) return null;

    return {
      canonicalPageId: doc.pageId || doc.id,
      spaceId: doc.spaceId,
      titleHint: doc.node?.path || doc.lastKnownPath || null,
    };
  }

  async findStorageFilesMetadata(
    ids: string[],
  ): Promise<Array<{ id: string; metadata: unknown }>> {
    if (!ids.length || !this.prisma.fileNode?.findMany) return [];
    const rows = await this.prisma.fileNode
      .findMany({
        where: { id: { in: ids } },
        select: { id: true, metadata: true },
      })
      .catch(() => []);
    return Array.isArray(rows) ? rows : [];
  }

  async findLibraryItemsWithAttachments(ids: string[]) {
    if (!ids.length || !this.prisma.libraryItem?.findMany) return [];
    const rows = await this.prisma.libraryItem
      .findMany({
        where: { id: { in: ids } },
        include: {
          attachments: {
            where: { deletedAt: null },
            select: { fileId: true, metadata: true, attachmentType: true },
          },
        },
      })
      .catch(() => []);
    return Array.isArray(rows) ? rows : [];
  }

  async findLibraryItemDetail(itemId: string) {
    if (!this.prisma.libraryItem?.findFirst) return null;
    return this.prisma.libraryItem
      .findFirst({
        where: { id: itemId, deletedAt: null },
        include: {
          contributors: { orderBy: { orderIndex: 'asc' } },
          attachments: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'asc' },
          },
        },
      })
      .catch(() => null);
  }

  async findStorageFileDetail(fileId: string, userId: string) {
    if (!this.prisma.fileNode?.findFirst) return null;
    return this.prisma.fileNode
      .findFirst({
        where: { id: fileId, deletedAt: null },
        include: {
          sharedWith: { where: { userId } },
        },
      })
      .catch(() => null);
  }

  async findAttachmentParentItemId(
    attachmentId: string,
  ): Promise<string | null> {
    if (!this.prisma.attachment?.findFirst) return null;
    const att = await this.prisma.attachment
      .findFirst({
        where: { id: attachmentId, deletedAt: null },
        select: { itemId: true },
      })
      .catch(() => null);
    return att?.itemId ?? null;
  }

  async isProjectMember(projectId: string, userId: string): Promise<boolean> {
    if (!this.prisma.projectMember?.findFirst) return false;
    const member = await this.prisma.projectMember
      .findFirst({
        where: { projectId, userId },
        select: { userId: true },
      })
      .catch(() => null);
    return member !== null;
  }

  async findUserLlmOverride(
    userId: string,
  ): Promise<LlmOverridePayload | null> {
    if (!userId || !this.prisma.userSettings?.findUnique) return null;
    const row = await this.prisma.userSettings
      .findUnique({
        where: { userId },
        select: { editorConfig: true },
      })
      .catch(() => null);
    return resolveDecryptedLlmOverride(row?.editorConfig);
  }

  async findUserProfile(userId: string): Promise<UserProfileContext | null> {
    if (!userId || !this.prisma.user?.findUnique) return null;
    const user = await this.prisma.user
      .findUnique({
        where: { id: userId },
        select: {
          email: true,
          profile: {
            select: {
              name: true,
              institution: true,
            },
          },
        },
      })
      .catch(() => null);
    if (!user) return null;
    const name = user.profile?.name?.trim() || undefined;
    const email = user.email?.trim() || undefined;
    const institution = user.profile?.institution?.trim() || undefined;
    if (!name && !email && !institution) return null;
    return {
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
      ...(institution ? { institution } : {}),
    };
  }
}
