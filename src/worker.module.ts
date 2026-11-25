import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { BullModule } from '@nestjs/bullmq';
import { CoreModule } from './core/core.module';
import { getQueueConfig } from './core/infrastructure/queue/queue.config';
import { FilesModule } from './modules/files/files.module';
import { ExperimentsModule } from './modules/experiments/experiments.module';
import { LibraryModule } from './modules/library/library.module';
import { IdentityModule } from './modules/identity/identity.module';
import { ProjectModule } from './modules/project/project.module';
import { PagesModule } from './modules/pages/pages.module';
import { AiModule } from './modules/ai/ai.module';
import { RealtimeModule } from './modules/realtime/realtime.module';

/**
 * Composition root dedicated exclusively for Flux Background Workers.
 * Runs BullMQ processors, OCR worker pools, and asynchronous pipelines
 * without initializing Fastify HTTP listeners, CORS, or Swagger.
 */
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
    ExperimentsModule,
    LibraryModule,
    PagesModule,
    RealtimeModule,
    AiModule,
  ],
})
export class WorkerModule {}
