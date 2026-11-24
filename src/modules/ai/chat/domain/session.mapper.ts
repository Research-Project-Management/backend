import type { AiMessage } from '@prisma/client';
import type {
  ChatWithMessages,
  FormattedChatMessage,
  FormattedChatSession,
} from '../types/chat.type';

export function sanitizeMessageContent(rawContent?: string | null): string {
  if (!rawContent) return '';
  return (
    rawContent
      .replace(/\0/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .trim()
      .slice(0, 50000)
  );
}

export function sanitizeMessageRole(role?: string): 'user' | 'assistant' {
  return role === 'assistant' ? 'assistant' : 'user';
}

export function formatChatMessage(m: AiMessage): FormattedChatMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    sources: m.role === 'assistant' ? m.sources : undefined,
    attachments:
      m.role === 'user' && Array.isArray(m.sources) && m.sources.length > 0
        ? m.sources
        : undefined,
    widgets: m.widgets,
    createdAt:
      m.createdAt instanceof Date
        ? m.createdAt.toISOString()
        : String(m.createdAt),
  };
}

export function formatChatSession(
  chat: ChatWithMessages,
): FormattedChatSession {
  const msgs = Array.isArray(chat.messages) ? chat.messages : [];
  const isSummary = chat._count !== undefined;
  const lastMsg =
    msgs.length > 0
      ? (isSummary ? msgs[0].content : msgs[msgs.length - 1].content) || ''
      : '';
  const projectId = chat.space?.projectId ?? null;

  return {
    id: chat.id,
    title: chat.title,
    spaceId: chat.spaceId,
    projectId,
    pageId: chat.pageId ?? null,
    messageCount: chat._count?.messages ?? msgs.length,
    lastMessage: lastMsg,
    documentIds: chat.documentIds || [],
    createdAt:
      chat.createdAt instanceof Date
        ? chat.createdAt.toISOString()
        : String(chat.createdAt),
    updatedAt:
      chat.updatedAt instanceof Date
        ? chat.updatedAt.toISOString()
        : String(chat.updatedAt),
    messages: msgs.map(formatChatMessage),
  };
}
