/**
 * Redis Key Namespaces for AI Chat Submodule
 *
 * Standardized according to redis-core colon key conventions:
 * flux:ai:{entity}:{identifier}
 */

export const AI_REDIS_KEYS = {
  /**
   * User AI chat sessions list in scope (project or personal) (JSON array, TTL 30m)
   */
  userChats: (userId: string, projectId?: string | null) =>
    projectId
      ? `flux:ai:chats:proj:${projectId}:user:${userId}`
      : `flux:ai:chats:user:${userId}`,

  /**
   * Full chat thread with message history (JSON object, TTL 30m)
   */
  chatThread: (chatId: string) => `flux:ai:chat:${chatId}`,

  /**
   * Alias for chat session cache
   */
  chatSession: (chatId: string) => `flux:ai:chat:${chatId}`,
} as const;
