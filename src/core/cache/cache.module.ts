import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisCacheService } from './redis.service';
import { CacheInvalidationListener } from './invalidation.listener';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [RedisCacheService, CacheInvalidationListener],
  exports: [RedisCacheService, CacheInvalidationListener],
})
export class CacheModule {}

