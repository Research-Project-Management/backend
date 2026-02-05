# Redis Cache Integration Guide

## Tính năng đã tích hợp

### 1. Session Store với Redis

- Session được lưu trong Redis thay vì memory
- Persistent sessions across server restarts
- TTL: 7 ngày
- Prefix: `rpm:sess:`

### 2. Rate Limiting với Redis

- Giới hạn: 100 requests / 15 phút mỗi IP
- Distributed rate limiting (hoạt động với multiple servers)
- Tự động block khi vượt quá giới hạn

### 3. Caching System

- Cache GET requests tự động
- TTL linh hoạt (SHORT, MEDIUM, LONG, HOUR, DAY)
- Auto-invalidation khi có thay đổi
- Pattern-based cache clearing

### 4. Security

- Helmet.js cho security headers
- Redis-backed rate limiting
- Session security với Redis

## Sử dụng Cache trong Code

### Cache Helper Functions

```javascript
import {
  getCache,
  setCache,
  deleteCache,
  deleteCacheByPattern,
  CACHE_DURATION,
} from "./app/libs/cache.js";

// Get cache
const data = await getCache("myKey");

// Set cache (5 phút)
await setCache("myKey", { data: "value" }, CACHE_DURATION.MEDIUM);

// Delete cache
await deleteCache("myKey");

// Delete by pattern
await deleteCacheByPattern("workspace:*");
```

### Cache Middleware

```javascript
import { cacheMiddleware } from "./app/libs/cache.js";

// Auto-cache GET requests trong 5 phút
router.get("/endpoint", cacheMiddleware(300), async (req, res) => {
  // Your code here
});
```

### Cache Keys

```javascript
import {
  workspaceCacheKey,
  userWorkspacesCacheKey,
  projectCacheKey,
  workspaceProjectsCacheKey,
} from "./app/libs/cache.js";

// workspace:123
const key1 = workspaceCacheKey("123");

// user:456:workspaces
const key2 = userWorkspacesCacheKey("456");
```

## Khởi động Redis

### Với Docker (Recommended)

```bash
cd RPM-BE
docker-compose up -d
```

### Kiểm tra Redis

```bash
# Check if running
docker ps | grep redis

# Connect to Redis CLI
docker exec -it rpm-redis redis-cli

# Test commands
> PING
PONG
> KEYS *
(list all keys)
```

### Stop Redis

```bash
docker-compose down
```

## Cache Strategy

### Cached Routes

- ✅ `GET /api/workspace` - User's workspaces (5 phút)
- ✅ `GET /api/workspace/:id` - Workspace details (5 phút)

### Cache Invalidation

- Tự động xóa cache khi:
  - Tạo workspace mới
  - Cập nhật workspace
  - Thêm/xóa members
  - Thay đổi settings

### Cache Keys Pattern

- `workspace:{id}` - Workspace data
- `user:{userId}:workspaces` - User's workspaces list
- `project:{id}` - Project data
- `workspace:{id}:projects` - Workspace's projects
- `cache:{route}` - Auto-cached routes

## Environment Variables

```env
REDIS_HOST=localhost
REDIS_PORT=6379
```

## Monitoring

### Redis Stats

```bash
# Connect to Redis
docker exec -it rpm-redis redis-cli

# Show info
> INFO

# Show all keys
> KEYS *

# Get key value
> GET "rpm:sess:xxx"

# Show memory usage
> INFO memory
```

## Best Practices

1. **Cache Duration**
   - User data: SHORT (1 phút)
   - Workspace data: MEDIUM (5 phút)
   - Static data: LONG (30 phút)

2. **Invalidation**
   - Invalidate specific keys, không xóa toàn bộ
   - Sử dụng pattern-based deletion cho related data

3. **Error Handling**
   - Cache failures không làm app crash
   - Fallback to database nếu Redis down

4. **Keys Naming**
   - Rõ ràng và có cấu trúc
   - Sử dụng prefix để group (workspace:, user:, etc.)
   - Include version nếu schema thay đổi

## Troubleshooting

### Redis không connect được

```bash
# Check if Redis is running
docker ps | grep redis

# Check logs
docker logs rpm-redis

# Restart Redis
docker-compose restart redis
```

### Clear all cache

```javascript
import { redisClient } from "./app/config/redis.js";
await redisClient.flushAll();
```

### Memory issues

```bash
# Set maxmemory in docker-compose.yml
command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
```
