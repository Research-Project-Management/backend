/**
 * Redis Key Namespaces for AI Module
 *
 * Standardized according to redis-core colon key conventions:
 * flux:ai:{entity}:{identifier}
 */

export const AI_REDIS_KEYS = {
  /**
   * User AI chat sessions list in scope (project or personal) (JSON array, TTL 30m)
   */
  userChats: (
    scopeId: string,
    userId: string,
    projectId?: string | null,
  ) =>
    `flux:ai:chats:${scopeId}:user:${userId}${projectId ? `:proj:${projectId}` : ''}`,

  /**
   * Full chat thread with message history (JSON object, TTL 30m)
   */
  chatThread: (chatId: string) => `flux:ai:chat:${chatId}`,
} as const;
