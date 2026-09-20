export const PROJECT_ACCESS_REDIS_KEYS = {
  /** Cache key for full member access context (role + overrides + effective permissions) */
  context: (projectId: string, userId: string) =>
    `project:access:${projectId}:${userId}`,

  /** Role cache key */
  role: (projectId: string, userId: string) =>
    `project:access:role:${projectId}:${userId}`,

  /** Permissions cache key */
  permissions: (projectId: string, userId: string) =>
    `project:access:perms:${projectId}:${userId}`,
};
