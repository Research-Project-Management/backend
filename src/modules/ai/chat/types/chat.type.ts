import type { AiChat, AiMessage, MessageRole } from '@prisma/client';
import type {
  EngineCitation,
  FrontendResponseWidget,
  FrontendSourceItem,
} from '../../engine/types/engine.type';

export type ChatWithMessages = AiChat & {
  messages: AiMessage[];
  space?: { projectId: string | null } | null;
  _count?: { messages: number };
};

export interface FormattedChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  sources?: unknown;
  attachments?: unknown;
  widgets?: unknown;
  createdAt: string;
}

export interface FormattedChatSession {
  id: string;
  title: string;
  spaceId: string;
  projectId: string | null;
  pageId: string | null;
  messageCount: number;
  lastMessage: string;
  documentIds: string[];
  createdAt: string;
  updatedAt: string;
  messages: FormattedChatMessage[];
}

export interface ExecuteChatResult {
  role: 'assistant';
  content: string;
  route: string;
  status: 'completed' | 'interrupted';
  sources: FrontendSourceItem[];
  citations: EngineCitation[];
  widgets?: FrontendResponseWidget[];
  interrupts: unknown[];
  usage: Record<string, unknown>;
  chatId: string;
  title: string;
  trace_id: string;
}
