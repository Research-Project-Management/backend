import { Global, Module } from '@nestjs/common';
import { RealtimeClientModule } from './client/module';

/**
 * Client integration module imported by the Web API and Background Worker processes.
 * The standalone Socket.IO service boots `RealtimeServerModule` via `src/realtime.ts`.
 */
@Global()
@Module({
  imports: [RealtimeClientModule],
  exports: [RealtimeClientModule],
})
export class RealtimeModule {}
