import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { BullModule } from '@nestjs/bullmq';
import { CoreModule } from './core/core.module';
import { HealthModule } from './health/health.module';
import { IdentityModule } from './modules/identity/identity.module';
import { ProjectModule } from './modules/project/project.module';
import { ActivityModule } from './modules/activity/activity.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { StickyModule } from './modules/sticky/sticky.module';
import { StorageModule } from './modules/storage/storage.module';
import { LibraryModule } from './modules/library/library.module';
import { DocumentModule } from './modules/document/document.module';
import { WorkItemModule } from './modules/work-item/work-item.module';
import { AiModule } from './modules/ai/ai.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
    }),
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      maxListeners: 100,
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisUrl =
          config.get<string>('REDIS_URL') ||
          process.env.REDIS_URL ||
          'redis://localhost:6379';
        let host = 'localhost';
        let port = 6379;
        let password: string | undefined;
        let username: string | undefined;
        let isTls = false;
        try {
          const parsed = new URL(redisUrl);
          host = parsed.hostname || 'localhost';
          port = parseInt(parsed.port || '6379', 10);
          if (parsed.password) password = decodeURIComponent(parsed.password);
          if (parsed.username && parsed.username !== 'default') {
            username = decodeURIComponent(parsed.username);
          }
          if (
            parsed.protocol === 'rediss:' ||
            redisUrl.startsWith('rediss://')
          ) {
            isTls = true;
          }
        } catch {
          // fallback
        }
        return {
          connection: {
            host,
            port,
            password,
            username,
            ...(isTls ? { tls: { rejectUnauthorized: false } } : {}),
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            enableOfflineQueue: false,
            keepAlive: 10000,
            retryStrategy: (times) => Math.min(times * 500, 3000),
          },
          defaultJobOptions: {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 2000,
            },
            removeOnComplete: 1000,
            removeOnFail: 5000,
          },
        };
      },
    }),
    CoreModule,
    HealthModule,
    IdentityModule,
    ProjectModule,
    ActivityModule,
    AnalyticsModule,
    StickyModule,
    WorkItemModule,
    DocumentModule,
    LibraryModule,
    StorageModule,
    AiModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
