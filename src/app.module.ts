import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { BullModule } from '@nestjs/bullmq';
import { CoreModule, getQueueConfig } from './core';
import { IdentityModule } from './modules/identity/identity.module';
import { ProjectModule } from './modules/project/project.module';
import { FilesModule } from './modules/files/files.module';
import { ExperimentsModule } from './modules/experiments/experiments.module';
import { LibraryModule } from './modules/library/library.module';
import { PagesModule } from './modules/pages/pages.module';

import { AiModule } from './modules/ai/ai.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { BffModule } from './modules/bff/bff.module';
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
      useFactory: getQueueConfig,
    }),
    CoreModule,
    IdentityModule,
    ProjectModule,
    FilesModule,
    PagesModule,

    LibraryModule,
    ExperimentsModule,
    AiModule,
    RealtimeModule,
    IntegrationsModule,
    BffModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
