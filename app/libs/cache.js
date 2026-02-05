import { redisClient } from "../config/redis.js";

/**
 * Cache Helper - Utility functions để làm việc với Redis cache
 */

// Cache duration constants (seconds)
export const CACHE_DURATION = {
  SHORT: 60, // 1 phút
  MEDIUM: 300, // 5 phút
  LONG: 1800, // 30 phút
  HOUR: 3600, // 1 giờ
  DAY: 86400, // 1 ngày
};

/**
 * Get cached data
 * @param {string} key - Cache key
 * @returns {Promise<any|null>}
 */
export async function getCache(key) {
  try {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error(`Error getting cache for key ${key}:`, error);
    return null;
  }
}

/**
 * Set cache with expiration
 * @param {string} key - Cache key
 * @param {any} value - Value to cache
 * @param {number} expirationInSeconds - TTL in seconds
 * @returns {Promise<boolean>}
 */
export async function setCache(
  key,
  value,
  expirationInSeconds = CACHE_DURATION.MEDIUM,
) {
  try {
    await redisClient.setEx(key, expirationInSeconds, JSON.stringify(value));
    return true;
  } catch (error) {
    console.error(`Error setting cache for key ${key}:`, error);
    return false;
  }
}

/**
 * Delete cache by key
 * @param {string} key - Cache key
 * @returns {Promise<boolean>}
 */
export async function deleteCache(key) {
  try {
    await redisClient.del(key);
    return true;
  } catch (error) {
    console.error(`Error deleting cache for key ${key}:`, error);
    return false;
  }
}

/**
 * Delete cache by pattern
 * @param {string} pattern - Key pattern (e.g., 'workspace:*')
 * @returns {Promise<number>} - Number of keys deleted
 */
export async function deleteCacheByPattern(pattern) {
  try {
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) {
      await redisClient.del(keys);
      return keys.length;
    }
    return 0;
  } catch (error) {
    console.error(`Error deleting cache by pattern ${pattern}:`, error);
    return 0;
  }
}

/**
 * Cache middleware - Tự động cache response
 * @param {number} duration - Cache duration in seconds
 * @returns {Function} Express middleware
 */
export function cacheMiddleware(duration = CACHE_DURATION.MEDIUM) {
  return async (req, res, next) => {
    // Chỉ cache GET requests
    if (req.method !== "GET") {
      return next();
    }

    // Tạo cache key từ route và query params
    const cacheKey = `cache:${req.originalUrl || req.url}`;

    try {
      // Kiểm tra cache
      const cachedData = await getCache(cacheKey);
      if (cachedData) {
        return res.json(cachedData);
      }

      // Override res.json để cache response
      const originalJson = res.json.bind(res);
      res.json = (data) => {
        // Cache data
        setCache(cacheKey, data, duration);
        return originalJson(data);
      };

      next();
    } catch (error) {
      console.error("Cache middleware error:", error);
      next();
    }
  };
}

/**
 * Generate cache key for workspace
 * @param {string} workspaceId
 * @returns {string}
 */
export function workspaceCacheKey(workspaceId) {
  return `workspace:${workspaceId}`;
}

/**
 * Generate cache key for user workspaces
 * @param {string} userId
 * @returns {string}
 */
export function userWorkspacesCacheKey(userId) {
  return `user:${userId}:workspaces`;
}

/**
 * Generate cache key for project
 * @param {string} projectId
 * @returns {string}
 */
export function projectCacheKey(projectId) {
  return `project:${projectId}`;
}

/**
 * Generate cache key for workspace projects
 * @param {string} workspaceId
 * @returns {string}
 */
export function workspaceProjectsCacheKey(workspaceId) {
  return `workspace:${workspaceId}:projects`;
}

/**
 * Clear all workspace related cache
 * @param {string} workspaceId
 * @returns {Promise<number>}
 */
export async function clearWorkspaceCache(workspaceId) {
  return await deleteCacheByPattern(`workspace:${workspaceId}*`);
}
