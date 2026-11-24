import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import type { AiChat, AiMessage, MessageRole, Prisma } from '@prisma/client';
import type { ChatWithMessages } from './types/chat.type';

const CHAT_INCLUDE = {
  messages: {
    orderBy: { createdAt: 'asc' as const },
  },
  space: {
    select: { projectId: true },
  },
};

const CHAT_SUMMARY_INCLUDE = {
  messages: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
  },
  _count: {
    select: { messages: true },
  },
  space: {
    select: { projectId: true },
  },
};

@Injectable()
export class ChatRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findUserChats(
    userId: string,
    spaceId?: string | null,
  ): Promise<ChatWithMessages[]> {
    return this.prisma.aiChat.findMany({
      where: {
        spaceId: spaceId || userId,
        createdById: userId,
      },
      include: CHAT_SUMMARY_INCLUDE,
      orderBy: { updatedAt: 'desc' },
    });
  }

  async findChatById(chatId: string): Promise<ChatWithMessages | null> {
    return this.prisma.aiChat.findUnique({
      where: { id: chatId },
      include: CHAT_INCLUDE,
    });
  }

  async findChatByIdAndUser(
    chatId: string,
    userId: string,
  ): Promise<ChatWithMessages | null> {
    return this.prisma.aiChat.findFirst({
      where: { id: chatId, createdById: userId },
      include: CHAT_INCLUDE,
    });
  }

  async existsChatForUser(chatId: string, userId: string): Promise<boolean> {
    const chat = await this.prisma.aiChat.findFirst({
      where: { id: chatId, createdById: userId },
      select: { id: true },
    });
    return chat !== null;
  }

  async findChatMessagesPage(
    chatId: string,
    skip: number,
    take: number,
  ): Promise<{ messages: AiMessage[]; total: number }> {
    const [messages, total] = await Promise.all([
      this.prisma.aiMessage.findMany({
        where: { chatId },
        orderBy: { createdAt: 'asc' },
        skip,
        take,
      }),
      this.prisma.aiMessage.count({
        where: { chatId },
      }),
    ]);
    return { messages, total };
  }

  async findPageChat(
    pageId: string,
    userId: string,
    spaceId?: string | null,
  ): Promise<ChatWithMessages | null> {
    const where: Prisma.AiChatWhereInput = {
      pageId,
      createdById: userId,
    };
    if (spaceId !== undefined) {
      where.spaceId = spaceId || userId;
    }

    return this.prisma.aiChat.findFirst({
      where,
      include: CHAT_INCLUDE,
      orderBy: { updatedAt: 'desc' },
    });
  }

  async deletePageChat(
    pageId: string,
    userId: string,
    spaceId?: string | null,
  ): Promise<{ count: number; chatIds: string[]; spaceIds: string[] }> {
    const where: Prisma.AiChatWhereInput = {
      pageId,
      createdById: userId,
    };
    if (spaceId !== undefined) {
      where.spaceId = spaceId || userId;
    }

    const matches = await this.prisma.aiChat.findMany({
      where,
      select: { id: true, spaceId: true },
    });
    if (!matches || matches.length === 0) {
      return { count: 0, chatIds: [], spaceIds: [] };
    }

    const chatIds = matches.map((m) => m.id);
    const spaceIds = Array.from(new Set(matches.map((m) => m.spaceId)));
    const deleted = await this.prisma.aiChat.deleteMany({
      where: { id: { in: chatIds } },
    });

    return {
      count: deleted.count,
      chatIds,
      spaceIds,
    };
  }

  async createChat(
    data: Prisma.AiChatCreateInput | Prisma.AiChatUncheckedCreateInput,
  ): Promise<ChatWithMessages> {
    return this.prisma.aiChat.create({
      data: data as Prisma.AiChatCreateInput,
      include: CHAT_INCLUDE,
    });
  }

  async updateChatTitle(
    chatId: string,
    title: string,
  ): Promise<ChatWithMessages> {
    return this.prisma.aiChat.update({
      where: { id: chatId },
      data: { title },
      include: CHAT_INCLUDE,
    });
  }

  async insertMessagesFast(
    chatId: string,
    messages: Array<{
      role: MessageRole;
      content: string;
      sources?: Prisma.InputJsonValue;
      widgets?: Prisma.InputJsonValue;
      selectionContext?: Prisma.InputJsonValue;
    }>,
    documentIds?: string[],
  ): Promise<void> {
    if (messages.length > 0) {
      await this.prisma.aiMessage.createMany({
        data: messages.map((m) => ({
          chatId,
          role: m.role,
          content: m.content || '',
          sources: m.sources ?? [],
          widgets: m.widgets ?? [],
          selectionContext: m.selectionContext,
        })),
      });
    }

    await this.prisma.aiChat.update({
      where: { id: chatId },
      data: {
        ...(documentIds && documentIds.length > 0 ? { documentIds } : {}),
        updatedAt: new Date(),
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
  ): Promise<ChatWithMessages | null> {
    await this.insertMessagesFast(chatId, messages, documentIds);
    return this.findChatById(chatId);
  }

  async deleteChat(chatId: string): Promise<AiChat> {
    return this.prisma.aiChat.delete({
      where: { id: chatId },
    });
  }

  async clearUserChats(
    userId: string,
    spaceId?: string | null,
  ): Promise<{ count: number; chatIds: string[] }> {
    const targetSpaceId = spaceId || userId;
    const where: Prisma.AiChatWhereInput = {
      spaceId: targetSpaceId,
      createdById: userId,
    };
    const matches = await this.prisma.aiChat
      .findMany({
        where,
        select: { id: true },
      })
      .catch(() => []);
    const chatIds = Array.isArray(matches) ? matches.map((m) => m.id) : [];

    const deleted = await this.prisma.aiChat.deleteMany({ where });
    return { count: deleted.count, chatIds };
  }

  async findFirstDocumentFilename(
    documentIds: string[],
  ): Promise<string | null> {
    if (!documentIds.length || !this.prisma.fileNode?.findFirst) {
      return null;
    }
    const file = await this.prisma.fileNode
      .findFirst({
        where: { id: { in: documentIds } },
        select: { filename: true },
      })
      .catch(() => null);
    return file?.filename ?? null;
  }
}
