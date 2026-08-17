import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ThreadRepository } from './thread.repository';
import {
  CreateThreadDto,
  AppendMessagesDto,
  RenameThreadDto,
} from './dto/thread.dto';
import { MessageRole } from '@prisma/client';

export interface FormattedChatSession {
  _id: string;
  id: string;
  title: string;
  projectId?: string | null;
  pageId?: string | null;
  workspaceSlug: string;
  messageCount: number;
  lastMessage: string;
  documentIds: string[];
  createdAt: string;
  updatedAt: string;
  messages?: Array<{
    id: string;
    role: string;
    content: string;
    sources?: unknown;
    widgets?: unknown;
    createdAt: string;
  }>;
}

function formatChat(chat: any): FormattedChatSession {
  const msgs = chat.messages || [];
  const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1].content || '' : '';

  return {
    _id: chat.id,
    id: chat.id,
    title: chat.title,
    projectId: chat.projectId,
    pageId: chat.pageId,
    workspaceSlug: chat.workspaceSlug,
    messageCount: msgs.length,
    lastMessage: lastMsg,
    documentIds: chat.documentIds || [],
    createdAt: chat.createdAt?.toISOString?.() || chat.createdAt,
    updatedAt: chat.updatedAt?.toISOString?.() || chat.updatedAt,
    messages: msgs.map((m: any) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      sources: m.sources,
      widgets: m.widgets,
      createdAt: m.createdAt?.toISOString?.() || m.createdAt,
    })),
  };
}

@Injectable()
export class ThreadService {
  constructor(private readonly threadRepo: ThreadRepository) {}

  async getChats(
    workspaceId: string,
    userId: string,
    projectId?: string | null,
  ): Promise<FormattedChatSession[]> {
    if (!workspaceId) {
      throw new BadRequestException('workspaceId is required');
    }
    const rawChats = await this.threadRepo.findUserChats(
      workspaceId,
      userId,
      projectId,
    );
    return rawChats.map(formatChat);
  }

  async getPageChat(pageId: string, workspaceId: string, userId: string) {
    if (!pageId || !workspaceId) {
      throw new BadRequestException('pageId and workspaceId are required');
    }
    const raw = await this.threadRepo.findPageChat(pageId, workspaceId, userId);
    return {
      chat: raw ? formatChat(raw) : null,
      messages: raw?.messages || [],
    };
  }

  async clearPageChat(pageId: string, workspaceId: string, userId: string) {
    if (!pageId || !workspaceId) {
      throw new BadRequestException('pageId and workspaceId are required');
    }
    await this.threadRepo.deletePageChat(pageId, workspaceId, userId);
    return { success: true };
  }

  async getChat(chatId: string): Promise<FormattedChatSession> {
    const raw = await this.threadRepo.findChatById(chatId);
    if (!raw) {
      throw new NotFoundException('Chat not found');
    }
    return formatChat(raw);
  }

  async createChat(
    userId: string,
    dto: CreateThreadDto,
  ): Promise<FormattedChatSession> {
    const workspaceSlug = dto.workspaceSlug || dto.workspaceId;
    if (!workspaceSlug) {
      throw new BadRequestException('workspaceSlug or workspaceId is required');
    }

    const created = await this.threadRepo.createChat({
      userId,
      workspaceSlug,
      projectId: dto.projectId,
      pageId: dto.pageId,
      title: dto.title,
      documentIds: dto.documentIds,
    });

    if (dto.messages && dto.messages.length > 0) {
      const formattedMessages = dto.messages.map((m: any) => ({
        role: (m.role as MessageRole) || MessageRole.user,
        content: m.content || '',
        sources: m.sources,
        widgets: m.widgets,
        selectionContext: m.selectionContext,
      }));
      const updated = await this.threadRepo.createMessages(
        created.id,
        formattedMessages,
        dto.documentIds,
      );
      return formatChat(updated);
    }

    return formatChat(created);
  }

  async appendMessages(
    chatId: string,
    dto: AppendMessagesDto,
  ): Promise<FormattedChatSession> {
    const chat = await this.threadRepo.findChatById(chatId);
    if (!chat) {
      throw new NotFoundException('Chat not found');
    }

    const formattedMessages = dto.messages.map((m: any) => ({
      role: (m.role as MessageRole) || MessageRole.user,
      content: m.content || '',
      sources: m.sources,
      widgets: m.widgets,
      selectionContext: m.selectionContext,
    }));

    const updated = await this.threadRepo.createMessages(
      chatId,
      formattedMessages,
      dto.documentIds,
    );
    return formatChat(updated);
  }

  async renameChat(
    chatId: string,
    dto: RenameThreadDto,
  ): Promise<FormattedChatSession> {
    const chat = await this.threadRepo.findChatById(chatId);
    if (!chat) {
      throw new NotFoundException('Chat not found');
    }

    const updated = await this.threadRepo.updateChatTitle(chatId, dto.title);
    return formatChat(updated);
  }

  async deleteChat(chatId: string) {
    await this.threadRepo.deleteChat(chatId);
    return { success: true };
  }

  async clearMemory(workspaceId: string, userId: string) {
    await this.threadRepo.clearUserWorkspaceChats(workspaceId, userId);
    return { success: true };
  }
}
