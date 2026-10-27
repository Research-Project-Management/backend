import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { BullModule } from '@nestjs/bullmq';
import { CoreModule } from './core/core.module';
import {
  getBullMqConfig,
  MANUSCRIPT_CLSI_QUEUE,
} from './core/infrastructure/queue/bullmq.config';
import { StorageModule } from './modules/storage/storage.module';
import { LibraryModule } from './modules/library/library.module';
import { IdentityModule } from './modules/identity/identity.module';
import { ProjectModule } from './modules/project/project.module';
import { ManuscriptsModule } from './modules/manuscripts/manuscripts.module';
import { ClsiCompileProcessor } from './modules/manuscripts/clsi/processors/clsi-compile.processor';

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
      useFactory: getBullMqConfig,
    }),
    BullModule.registerQueue({
      name: MANUSCRIPT_CLSI_QUEUE,
    }),
    CoreModule,
    IdentityModule,
    ProjectModule,
    StorageModule,
    LibraryModule,
    ManuscriptsModule,
  ],
  providers: [ClsiCompileProcessor],
})
export class WorkerModule {}
