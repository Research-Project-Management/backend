export const AI_ENGINE_PORT = 'AI_ENGINE_PORT';
export const AI_FACADE = 'AI_FACADE';
export const AI_KNOWLEDGE_QUEUE = 'AI_KNOWLEDGE_QUEUE';

export const AI_JOB_INGEST_FILE = 'ai.knowledge.ingest-file';
export const AI_JOB_DELETE_FILE = 'ai.knowledge.delete-file';

export const AI_REDIS_KEYS = {
  userChats: (userId: string, spaceId?: string | null) =>
    `ai:chats:${userId}:${spaceId || 'personal'}`,
  chatSession: (chatId: string) => `ai:chat:${chatId}`,
} as const;

export const AI_ENGINE_TIMEOUTS_MS = {
  HEALTH: 5_000,
  METADATA: 10_000,
  STANDARD: 15_000,
  SEARCH: 30_000,
  CHAT_SYNC: 120_000,
  INGEST_DEADLINE: 120_000,
  INGEST_POLL_INTERVAL: 500,
  DEFAULT: 60_000,
} as const;

export const AI_CONTEXT_CHAR_LIMITS = {
  DOCUMENT_STRUCTURE: 10_000,
  FILE_CONTENT: 100_000,
  SELECTION: 20_000,
  CURSOR_CONTEXT: 10_000,
  CONTEXT_BEFORE: 15_000,
  CONTEXT_AFTER: 15_000,
  CURRENT_SECTION: 1_000,
  CURRENT_ENVIRONMENT: 500,
  DOCUMENT_STRUCTURE_SUMMARY: 10_000,
} as const;
