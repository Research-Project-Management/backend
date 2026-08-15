import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma } from '@prisma/client';

export type AiChatWithMessages = Prisma.AiChatGetPayload<{
  include: {
    messages: true;
  };
}>;

@Injectable()
export class ChatHistoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findUserChats(userId: string, workspaceSlug?: string) {
    return this.prisma.aiChat.findMany({
      where: {
        userId,
        ...(workspaceSlug && { workspaceSlug }),
      },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async findChatById(chatId: string) {
    return this.prisma.aiChat.findUnique({
      where: { id: chatId },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
  }

  async findPageChat(pageId: string, userId: string) {
    return this.prisma.aiChat.findFirst({
      where: {
        pageId,
        userId,
      },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
  }

  async createChat(
    data: Prisma.AiChatCreateInput | Prisma.AiChatUncheckedCreateInput,
  ) {
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
  ) {
    return this.prisma.aiChat.update({
      where: { id: chatId },
      data: data,
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
  }

  async deleteChat(chatId: string) {
    return this.prisma.aiChat.delete({
      where: { id: chatId },
    });
  }

  async deleteChats(where: Prisma.AiChatWhereInput) {
    return this.prisma.aiChat.deleteMany({
      where,
    });
  }

  async createMessage(
    data: Prisma.AiMessageCreateInput | Prisma.AiMessageUncheckedCreateInput,
  ) {
    return this.prisma.aiMessage.create({
      data: data as Prisma.AiMessageCreateInput,
    });
  }
}
