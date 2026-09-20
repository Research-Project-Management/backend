/**
 * AI Chat Domain Types & Repository Port Interface
 *
 * Implements Hexagonal / Clean Architecture decoupling Prisma models from services.
 */

import { AiChat, AiMessage, MessageRole, Prisma } from '@prisma/client';

export type ChatWithMessages = Prisma.AiChatGetPayload<{
  include: {
    messages: true;
  };
}>;

export interface FormattedChatSession {
  id: string;
  title: string;
  projectId?: string | null;
  pageId?: string | null;
  scopeSlug?: string;
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

export interface IChatRepository {
  findUserChats(
    userId: string,
    projectId?: string | null,
  ): Promise<ChatWithMessages[]>;
  findChatById(chatId: string): Promise<ChatWithMessages | null>;
  findChatByIdAndUser(
    chatId: string,
    userId: string,
  ): Promise<ChatWithMessages | null>;
  findPageChat(
    pageId: string,
    userId: string,
  ): Promise<ChatWithMessages | null>;
  createChat(
    data: Prisma.AiChatCreateInput | Prisma.AiChatUncheckedCreateInput,
  ): Promise<ChatWithMessages>;
  updateChat(
    chatId: string,
    data: Prisma.AiChatUpdateInput | Prisma.AiChatUncheckedUpdateInput,
  ): Promise<ChatWithMessages>;
  deleteChat(chatId: string): Promise<AiChat>;
  deletePageChat(pageId: string, userId: string): Promise<{ count: number }>;
  clearUserChats(
    userId: string,
    projectId?: string | null,
  ): Promise<{ count: number }>;
  appendMessage(
    chatId: string,
    message: {
      role: MessageRole;
      content: string;
      sources?: unknown;
      widgets?: unknown;
      selectionContext?: unknown;
    },
  ): Promise<AiMessage>;
  createMessages(
    chatId: string,
    messages: Array<{
      role: MessageRole;
      content: string;
      sources?: Prisma.InputJsonValue;
      widgets?: Prisma.InputJsonValue;
      selectionContext?: Prisma.InputJsonValue;
    }>,
    documentIds?: string[],
  ): Promise<ChatWithMessages | null>;
  updateChatTitle(chatId: string, title: string): Promise<ChatWithMessages>;
}

// Backward compatibility alias
export type IAiRepository = IChatRepository;
