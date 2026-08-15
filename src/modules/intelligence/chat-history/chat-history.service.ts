import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ChatHistoryRepository,
  AiChatWithMessages,
} from './chat-history.repository';
import {
  CreateChatDto,
  AppendMessagesDto,
  RenameChatDto,
} from './dto/chat-history.dto';
import { MessageRole, Prisma } from '@prisma/client';

export type { AiChatWithMessages };

@Injectable()
export class ChatHistoryService {
  constructor(private readonly chatRepo: ChatHistoryRepository) {}

  async getChats(workspaceId: string, userId: string) {
    const chats = await this.chatRepo.findUserChats(userId, workspaceId);
    return chats;
  }

  async createChat(userId: string, dto: CreateChatDto) {
    const chat = await this.chatRepo.createChat({
      userId,
      workspaceSlug: dto.workspaceSlug || dto.workspaceId || 'default',
      projectId: dto.projectId || null,
      pageId: dto.pageId || null,
      title: dto.title || 'New Chat',
    });

    return chat;
  }

  async getPageChat(pageId: string, workspaceId: string, userId: string) {
    let chat = await this.chatRepo.findPageChat(pageId, userId);

    if (!chat) {
      chat = await this.chatRepo.createChat({
        userId,
        pageId,
        workspaceSlug: workspaceId || 'default',
        title: 'Document Discussion',
      });
    }

    return chat;
  }

  async clearPageChat(pageId: string, userId: string) {
    await this.chatRepo.deleteChats({ pageId, userId });
    return { success: true, message: 'Page chat cleared' };
  }

  async getChat(chatId: string, _userId: string) {
    const chat = await this.chatRepo.findChatById(chatId);

    if (!chat) {
      throw new NotFoundException('Chat not found');
    }

    return chat;
  }

  async appendMessages(
    chatId: string,
    _userId: string,
    dto: AppendMessagesDto,
  ) {
    const chat = await this.chatRepo.findChatById(chatId);

    if (!chat) {
      throw new NotFoundException('Chat not found');
    }

    // Fast-path: Short-circuit if no messages to append
    if (!dto.messages || dto.messages.length === 0) {
      return chat;
    }

    await Promise.all(
      dto.messages.map((msg) => {
        const role =
          msg.role === 'assistant' ? MessageRole.assistant : MessageRole.user;

        return this.chatRepo.createMessage({
          chatId,
          role,
          content:
            typeof msg.content === 'string'
              ? msg.content
              : typeof msg.content === 'number'
                ? msg.content.toString()
                : '',
          sources: Array.isArray(msg.sources) ? (msg.sources as string[]) : [],
          widgets: Array.isArray(msg.widgets)
            ? (msg.widgets as Prisma.InputJsonValue)
            : [],
          selectionContext:
            msg.selectionContext !== undefined
              ? (msg.selectionContext as Prisma.InputJsonValue)
              : Prisma.JsonNull,
        });
      }),
    );

    const updated = await this.chatRepo.findChatById(chatId);
    return updated;
  }

  async renameChat(chatId: string, _userId: string, dto: RenameChatDto) {
    const chat = await this.chatRepo.updateChat(chatId, {
      title: dto.title,
    });

    return chat;
  }

  async deleteChat(chatId: string, _userId: string) {
    await this.chatRepo.deleteChat(chatId);
    return { success: true, message: 'Chat deleted' };
  }

  async clearMemory(workspaceId: string, userId: string) {
    await this.chatRepo.deleteChats({
      userId,
      ...(workspaceId && { workspaceSlug: workspaceId }),
    });

    return { success: true, message: 'Memory cleared' };
  }
}
