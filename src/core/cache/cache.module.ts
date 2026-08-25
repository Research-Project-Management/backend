import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisCacheService } from './redis-cache.service';
import { CacheInvalidationListener } from './cache-invalidation.listener';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [RedisCacheService, CacheInvalidationListener],
  exports: [RedisCacheService, CacheInvalidationListener],
})
export class CacheModule {}
