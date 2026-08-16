import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { MessageRole, Prisma } from '@prisma/client';

@Injectable()
export class ThreadRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findUserChats(workspaceSlug: string, userId: string) {
    return this.prisma.aiChat.findMany({
      where: {
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

  async createChat(data: {
    userId: string;
    workspaceSlug: string;
    projectId?: string;
    pageId?: string;
    title?: string;
  }) {
    return this.prisma.aiChat.create({
      data: {
        userId: data.userId,
        workspaceSlug: data.workspaceSlug,
        projectId: data.projectId,
        pageId: data.pageId,
        title: data.title || 'New Chat',
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
  ) {
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
}
