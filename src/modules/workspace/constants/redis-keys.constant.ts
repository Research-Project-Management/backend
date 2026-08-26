/**
 * Redis Key Namespaces for Workspace Module
 *
 * Standardized according to redis-core colon key conventions:
 * flux:ws:{entity}:{identifier}
 */

export const WORKSPACE_REDIS_KEYS = {
  /**
   * Workspace full details by ID (String/JSON, TTL 1h)
   */
  workspace: (workspaceId: string) => `flux:ws:${workspaceId}`,

  /**
   * Workspace ID by Slug/URL (String, TTL 2h)
   */
  slug: (slug: string) => `flux:ws:slug:${slug}`,

  /**
   * List of workspaces for a specific user (String/JSON array, TTL 30m)
   */
  userWorkspaces: (userId: string) => `flux:ws:user_workspaces:${userId}`,

  /**
   * Quick invite code to Workspace ID (String, TTL 24h)
   */
  inviteCode: (code: string) => `flux:ws:invite_code:${code}`,

  /**
   * Pending invitations for a workspace (String/JSON array, TTL 10m)
   */
  pendingInvitations: (workspaceId: string) =>
    `flux:ws:invitations:${workspaceId}`,
} as const;
