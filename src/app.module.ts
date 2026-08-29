import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CoreModule } from './core/core.module';
import { HealthModule } from './health/health.module';
import { IamModule } from './modules/iam/iam.module';
import { WorkspaceModule } from './modules/workspace/workspace.module';
import { ProjectModule } from './modules/project/project.module';
import { ActivityModule } from './modules/activity/activity.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { StickyModule } from './modules/sticky/sticky.module';
import { StorageModule } from './modules/storage/storage.module';
import { LibraryModule } from './modules/library/library.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
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
      maxListeners: 20,
    }),
    CoreModule,
    HealthModule,
    IamModule,
    WorkspaceModule,
    ProjectModule,
    ActivityModule,
    AnalyticsModule,
    StickyModule,
    WorkItemModule,
    DocumentModule,
    LibraryModule,
    IntegrationsModule,
    StorageModule,
    AiModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
