import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { BullModule } from '@nestjs/bullmq';
import { CoreModule, getBullMqConfig } from './core';
import { IdentityModule } from './modules/identity/identity.module';
import { ProjectModule } from './modules/project/project.module';
import { ActivityModule } from './modules/activity/activity.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { StickyModule } from './modules/sticky/sticky.module';
import { StorageModule } from './modules/storage/storage.module';
import { LibraryModule } from './modules/library/library.module';
import { ManuscriptsModule } from './modules/manuscripts/manuscripts.module';
import { WorkItemModule } from './modules/work-item';
import { AiModule } from './modules/ai/ai.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { ChatModule } from './modules/chat/chat.module';
import { AppController } from './app.controller';

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
      useFactory: getBullMqConfig,
    }),
    CoreModule,
    IdentityModule,
    ProjectModule,
    ActivityModule,
    AnalyticsModule,
    StickyModule,
    WorkItemModule,
    ManuscriptsModule,
    LibraryModule,
    StorageModule,
    AiModule,
    RealtimeModule,
    NotificationsModule,
    IntegrationsModule,
    ChatModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
