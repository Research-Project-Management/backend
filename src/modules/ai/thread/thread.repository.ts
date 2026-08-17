import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { MessageRole, Prisma } from '@prisma/client';

@Injectable()
export class ThreadRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findUserChats(workspaceSlug: string, userId: string, projectId?: string | null) {
    const where: Prisma.AiChatWhereInput = {
      workspaceSlug,
      userId,
    };
    if (projectId) {
      where.projectId = projectId;
    }

    return this.prisma.aiChat.findMany({
      where,
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async findChatById(chatId: string) {
    return this.prisma.aiChat.findUnique({
      where: { id: chatId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }

  async findPageChat(pageId: string, workspaceSlug: string, userId: string) {
    return this.prisma.aiChat.findFirst({
      where: {
        pageId,
        workspaceSlug,
        userId,
      },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async deletePageChat(pageId: string, workspaceSlug: string, userId: string) {
    const chat = await this.findPageChat(pageId, workspaceSlug, userId);
    if (chat) {
      await this.prisma.aiChat.delete({
        where: { id: chat.id },
      });
    }
  }

  async createChat(data: {
    userId: string;
    workspaceSlug: string;
    projectId?: string;
    pageId?: string;
    title?: string;
    documentIds?: string[];
  }) {
    return this.prisma.aiChat.create({
      data: {
        userId: data.userId,
        workspaceSlug: data.workspaceSlug,
        projectId: data.projectId,
        pageId: data.pageId,
        title: data.title || 'New Chat',
        documentIds: data.documentIds || [],
      },
      include: {
        messages: true,
      },
    });
  }

  async createMessages(
    chatId: string,
    messages: Array<{
      role: MessageRole;
      content: string;
      sources?: Prisma.InputJsonValue;
      widgets?: Prisma.InputJsonValue;
      selectionContext?: Prisma.InputJsonValue;
    }>,
    documentIds?: string[],
  ) {
    if (messages.length > 0) {
      await this.prisma.aiMessage.createMany({
        data: messages.map((m) => ({
          chatId,
          role: m.role,
          content: m.content || '',
          sources: m.sources || [],
          widgets: m.widgets || [],
          selectionContext: m.selectionContext,
        })),
      });
    }

    if (documentIds && documentIds.length > 0) {
      await this.prisma.aiChat.update({
        where: { id: chatId },
        data: {
          documentIds,
          updatedAt: new Date(),
        },
      });
    } else {
      await this.prisma.aiChat.update({
        where: { id: chatId },
        data: {
          updatedAt: new Date(),
        },
      });
    }

    return this.findChatById(chatId);
  }

  async updateChatTitle(chatId: string, title: string) {
    return this.prisma.aiChat.update({
      where: { id: chatId },
      data: { title },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }

  async deleteChat(chatId: string) {
    return this.prisma.aiChat.delete({
      where: { id: chatId },
    });
  }

  async clearUserWorkspaceChats(workspaceSlug: string, userId: string) {
    return this.prisma.aiChat.deleteMany({
      where: {
        workspaceSlug,
        userId,
      },
    });
  }
}
