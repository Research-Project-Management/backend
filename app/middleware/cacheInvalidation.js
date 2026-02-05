import {
  deleteCache,
  deleteCacheByPattern,
  workspaceCacheKey,
  projectCacheKey,
  workspaceProjectsCacheKey,
} from "../libs/cache.js";

/**
 * Middleware để tự động invalidate cache sau khi thay đổi dữ liệu
 */

/**
 * Clear workspace cache sau khi có thay đổi
 */
export function invalidateWorkspaceCache() {
  return async (req, res, next) => {
    // Store original json method
    const originalJson = res.json.bind(res);

    // Override json method
    res.json = async (data) => {
      // Nếu request thành công (status 2xx)
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const workspaceId = req.params.id || req.workspace?._id;

        if (workspaceId) {
          // Xóa cache của workspace
          await deleteCache(workspaceCacheKey(workspaceId));

          // Xóa cache của tất cả user workspaces (vì có thể có members mới)
          await deleteCacheByPattern(`user:*:workspaces`);

          // Xóa cache projects của workspace
          await deleteCache(workspaceProjectsCacheKey(workspaceId));
        }
      }

      return originalJson(data);
    };

    next();
  };
}

/**
 * Clear project cache sau khi có thay đổi
 */
export function invalidateProjectCache() {
  return async (req, res, next) => {
    const originalJson = res.json.bind(res);

    res.json = async (data) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const projectId = req.params.projectId || req.params.id;
        const workspaceId = req.params.workspaceId || req.body.workspaceId;

        if (projectId) {
          await deleteCache(projectCacheKey(projectId));
        }

        if (workspaceId) {
          await deleteCache(workspaceProjectsCacheKey(workspaceId));
        }
      }

      return originalJson(data);
    };

    next();
  };
}

/**
 * Clear cache theo pattern
 */
export function invalidateCachePattern(pattern) {
  return async (req, res, next) => {
    const originalJson = res.json.bind(res);

    res.json = async (data) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        await deleteCacheByPattern(pattern);
      }

      return originalJson(data);
    };

    next();
  };
}
