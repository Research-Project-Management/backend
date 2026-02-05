# 🚀 Redis Integration - RPM Backend

Redis đã được tích hợp đầy đủ vào backend với các tính năng sau:

## ✅ Tính năng đã tích hợp

### 1. 🔐 Session Store với Redis

- **Persistent sessions** - Session không mất khi restart server
- **Distributed sessions** - Hoạt động với nhiều server instances
- **TTL**: 7 ngày
- **Prefix**: `rpm:sess:`

### 2. 🛡️ Rate Limiting với Redis

- **Giới hạn**: 100 requests / 15 phút / IP
- **Distributed** - Sync giữa nhiều servers
- **Tự động block** - Chặn IP khi vượt quá limit
- **Message**: "Too many requests from this IP, please try again later."

### 3. 💾 Caching System

- **Auto-cache** - Tự động cache GET requests
- **Smart invalidation** - Tự động xóa cache khi có thay đổi
- **Flexible TTL** - SHORT (1m), MEDIUM (5m), LONG (30m), HOUR, DAY
- **Pattern-based** - Xóa cache theo pattern

### 4. 🔒 Security với Helmet

- Security headers tự động
- XSS protection
- Content Security Policy

## 📁 Files đã tạo/chỉnh sửa

### Cấu hình

- ✅ `docker-compose.yml` - Redis service
- ✅ `app/config/redis.js` - Redis client configuration
- ✅ `.env` - REDIS_HOST và REDIS_PORT

### Libraries

- ✅ `app/libs/cache.js` - Cache helper functions
- ✅ `app/middleware/cacheInvalidation.js` - Auto cache invalidation

### Routes với Cache

- ✅ `app/route/workspace.js` - Workspace caching
- ✅ `index.js` - Redis session store + rate limiting

### Documentation

- ✅ `REDIS_GUIDE.md` - Hướng dẫn chi tiết

## 🚀 Khởi động

### 1. Start Redis

```bash
cd RPM-BE
docker-compose up -d
```

### 2. Kiểm tra Redis

```bash
# Check status
docker ps | grep redis

# View logs
docker logs rpm-redis

# Connect to CLI
docker exec -it rpm-redis redis-cli
> PING
PONG
```

### 3. Start Backend

```bash
cd RPM-BE
pnpm dev
```

Bạn sẽ thấy:

```
✅ Connected to Redis successfully
✅ Redis is ready to use
Server is running on http://localhost:2915
```

## 📊 Caching Đã Áp Dụng

### ✅ Workspace Routes

```javascript
// GET /api/workspace - User's workspaces (5 phút)
// Key: user:{userId}:workspaces

// GET /api/workspace/:id - Workspace detail (chưa implement full)
// Key: workspace:{workspaceId}
```

### 🔄 Cache Invalidation

Tự động xóa cache khi:

- ✅ Tạo workspace mới → xóa `user:{userId}:workspaces`
- ✅ Cập nhật workspace → xóa `workspace:{id}` và `user:*:workspaces`
- ✅ Thêm/xóa member → xóa workspace cache

## 💡 Sử dụng trong Code

### Basic Cache Operations

```javascript
import {
  getCache,
  setCache,
  deleteCache,
  deleteCacheByPattern,
  CACHE_DURATION,
} from "./app/libs/cache.js";

// Get
const data = await getCache("myKey");

// Set với TTL 5 phút
await setCache("myKey", { some: "data" }, CACHE_DURATION.MEDIUM);

// Delete
await deleteCache("myKey");

// Delete by pattern
await deleteCacheByPattern("workspace:*");
```

### Cache Middleware

```javascript
import { cacheMiddleware } from "./app/libs/cache.js";

// Auto-cache GET request trong 5 phút
router.get("/data", cacheMiddleware(300), async (req, res) => {
  // Your code
});
```

### Cache Keys

```javascript
import {
  workspaceCacheKey, // workspace:123
  userWorkspacesCacheKey, // user:456:workspaces
  projectCacheKey, // project:789
  workspaceProjectsCacheKey, // workspace:123:projects
} from "./app/libs/cache.js";
```

## 📦 Dependencies đã cài

```json
{
  "redis": "^5.10.0",
  "connect-redis": "^9.0.0",
  "rate-limit-redis": "^4.3.1"
}
```

## 🔧 Environment Variables

```env
REDIS_HOST=localhost
REDIS_PORT=6379
```

## 📈 Monitoring

### Redis CLI Commands

```bash
docker exec -it rpm-redis redis-cli

# Show all keys
> KEYS *

# Get value
> GET "rpm:sess:xxx"

# Show info
> INFO

# Memory usage
> INFO memory

# Monitor real-time
> MONITOR
```

### Clear Cache

```javascript
// Clear all cache
import { redisClient } from "./app/config/redis.js";
await redisClient.flushAll();

// Clear by pattern
import { deleteCacheByPattern } from "./app/libs/cache.js";
await deleteCacheByPattern("workspace:*");
```

## 🎯 Next Steps

### Thêm cache cho các routes khác:

1. **Projects** - Cache project list và details
2. **Tasks** - Cache tasks by workspace/project
3. **Pages** - Cache page content
4. **Files** - Cache file metadata

### Example implementation:

```javascript
// app/route/project.js
import { cacheMiddleware, CACHE_DURATION } from "../libs/cache.js";

// Auto-cache projects
router.get(
  "/workspace/:workspaceId/projects",
  cacheMiddleware(CACHE_DURATION.MEDIUM),
  async (req, res) => {
    // Your code
  },
);
```

## ⚠️ Troubleshooting

### Redis không connect được

```bash
# Check Docker
docker ps | grep redis
docker logs rpm-redis

# Restart
docker-compose restart redis
```

### Clear all sessions

```bash
docker exec -it rpm-redis redis-cli
> KEYS rpm:sess:*
> DEL rpm:sess:xxx
```

### Memory issues

Edit `docker-compose.yml`:

```yaml
command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
```

## 📚 Resources

- [Redis Official Docs](https://redis.io/docs/)
- [connect-redis](https://github.com/tj/connect-redis)
- [rate-limit-redis](https://github.com/wyattjoh/rate-limit-redis)
- [Redis Best Practices](https://redis.io/docs/manual/patterns/)

---

**Ready to use! 🎉**

Redis cache đang hoạt động với:

- ✅ Session persistence
- ✅ Rate limiting
- ✅ Workspace caching
- ✅ Auto invalidation
- ✅ Security headers

Giờ ứng dụng sẽ nhanh hơn và scalable hơn! 🚀
