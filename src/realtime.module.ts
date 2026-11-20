import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CacheModule, HealthModule, LoggerModule, PrismaModule } from './core';
import { RealtimeServerModule } from './modules/realtime/server/module';

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
    PrismaModule,
    CacheModule,
    LoggerModule,
    HealthModule,
    RealtimeServerModule,
  ],
})
export class RealtimeServiceAppModule {}
