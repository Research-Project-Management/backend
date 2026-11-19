export const AI_ENGINE_PORT = 'AI_ENGINE_PORT';
export const AI_FACADE = 'AI_FACADE';
export const AI_KNOWLEDGE_QUEUE = 'AI_KNOWLEDGE_QUEUE';

export const AI_JOB_INGEST_FILE = 'ai.knowledge.ingest-file';
export const AI_JOB_DELETE_FILE = 'ai.knowledge.delete-file';

export const AI_REDIS_KEYS = {
  userChats: (userId: string, spaceId?: string | null) =>
    `ai:chats:${userId}:${spaceId || 'personal'}`,
  chatSession: (chatId: string) => `ai:chat:${chatId}`,
  paperQa: (spaceId: string, docKey: string, queryHash: string) =>
    `ai:paper-qa:${spaceId}:${docKey}:${queryHash}`,
} as const;
