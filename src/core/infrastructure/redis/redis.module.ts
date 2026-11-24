import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisCacheService } from './cache.service';
import { DistributedLockService } from './lock.service';
import { RedisPubSubService } from './pubsub.service';
import { CacheInvalidationListener } from './invalidation.listener';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    RedisCacheService,
    DistributedLockService,
    RedisPubSubService,
    CacheInvalidationListener,
  ],
  exports: [RedisCacheService, DistributedLockService, RedisPubSubService],
})
export class RedisModule {}
