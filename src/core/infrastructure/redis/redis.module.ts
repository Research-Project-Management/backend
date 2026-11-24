import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisCacheService } from './cache.service';
import { RedisCommandService } from './command.service';
import { DistributedLockService } from './lock.service';
import { RedisPubSubService } from './pubsub.service';
import { CacheInvalidationListener } from './invalidation.listener';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    RedisCacheService,
    RedisCommandService,
    DistributedLockService,
    RedisPubSubService,
    CacheInvalidationListener,
  ],
  exports: [
    RedisCacheService,
    RedisCommandService,
    DistributedLockService,
    RedisPubSubService,
  ],
})
export class RedisModule {}
