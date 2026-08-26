/**
 * AI Domain Repository Interface (Port)
 *
 * Implements Hexagonal / DDD-Lite Architecture decoupling Prisma models from services.
 */

import { AiChat, AiMessage, MessageRole, Prisma } from '@prisma/client';

export type ChatWithMessages = Prisma.AiChatGetPayload<{
  include: {
    messages: true;
  };
}>;

export interface IAiRepository {
  findUserChats(
    workspaceSlug: string,
    userId: string,
    projectId?: string | null,
  ): Promise<ChatWithMessages[]>;
  findChatById(chatId: string): Promise<ChatWithMessages | null>;
  findPageChat(
    pageId: string,
    workspaceSlug: string,
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
  deletePageChat(
    pageId: string,
    workspaceSlug: string,
    userId: string,
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
}
