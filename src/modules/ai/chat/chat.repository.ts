import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { MessageRole, Prisma, AiChat, AiMessage } from '@prisma/client';
import {
  IChatRepository,
  ChatWithMessages,
} from './types/chat.type';

export type { ChatWithMessages };

@Injectable()
export class ChatRepository implements IChatRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findUserChats(
    userId: string,
    projectId?: string | null,
  ): Promise<ChatWithMessages[]> {
    const where: Prisma.AiChatWhereInput = {
      userId,
    };
    if (projectId !== undefined) {
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

  async findChatById(chatId: string): Promise<ChatWithMessages | null> {
    return this.prisma.aiChat.findUnique({
      where: { id: chatId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }

  async findChatByIdAndUser(
    chatId: string,
    userId: string,
  ): Promise<ChatWithMessages | null> {
    return this.prisma.aiChat.findFirst({
      where: { id: chatId, userId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }

  async findPageChat(
    pageId: string,
    userId: string,
  ): Promise<ChatWithMessages | null> {
    return this.prisma.aiChat.findFirst({
      where: {
        pageId,
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

  async deletePageChat(
    pageId: string,
    userId: string,
  ): Promise<{ count: number }> {
    const chat = await this.findPageChat(pageId, userId);
    if (chat) {
      await this.prisma.aiChat.delete({
        where: { id: chat.id },
      });
      return { count: 1 };
    }
    return { count: 0 };
  }

  async createChat(
    data: Prisma.AiChatCreateInput | Prisma.AiChatUncheckedCreateInput,
  ): Promise<ChatWithMessages> {
    return this.prisma.aiChat.create({
      data: data as Prisma.AiChatCreateInput,
      include: {
        messages: true,
      },
    });
  }

  async updateChat(
    chatId: string,
    data: Prisma.AiChatUpdateInput | Prisma.AiChatUncheckedUpdateInput,
  ): Promise<ChatWithMessages> {
    return this.prisma.aiChat.update({
      where: { id: chatId },
      data,
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }

  async appendMessage(
    chatId: string,
    message: {
      role: MessageRole;
      content: string;
      sources?: unknown;
      widgets?: unknown;
      selectionContext?: unknown;
    },
  ): Promise<AiMessage> {
    const created = await this.prisma.aiMessage.create({
      data: {
        chatId,
        role: message.role,
        content: message.content || '',
        sources: (message.sources as Prisma.InputJsonValue) || [],
        widgets: (message.widgets as Prisma.InputJsonValue) || [],
        selectionContext: message.selectionContext as Prisma.InputJsonValue,
      },
    });

    await this.prisma.aiChat.update({
      where: { id: chatId },
      data: { updatedAt: new Date() },
    });

    return created;
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
    return this.updateChat(chatId, { title });
  }

  async deleteChat(chatId: string): Promise<AiChat> {
    return this.prisma.aiChat.delete({
      where: { id: chatId },
    });
  }

  async clearUserChats(
    userId: string,
    projectId?: string | null,
  ): Promise<{ count: number }> {
    const where: Prisma.AiChatWhereInput = {
      userId,
    };
    if (projectId !== undefined) {
      where.projectId = projectId;
    }
    return this.prisma.aiChat.deleteMany({
      where,
    });
  }
}

// Backward compatibility aliases
export const ThreadRepository = ChatRepository;
export type ThreadRepository = ChatRepository;
