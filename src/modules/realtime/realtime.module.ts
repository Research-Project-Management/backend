import { Module, Global } from '@nestjs/common';
import { RealtimeCoreModule } from './core/core.module';
import { RealtimePagesModule } from './pages/pages.module';
import { RealtimeFacade } from './realtime.facade';

@Global()
@Module({
  imports: [RealtimeCoreModule, RealtimePagesModule],
  providers: [RealtimeFacade],
  exports: [RealtimeFacade, RealtimeCoreModule, RealtimePagesModule],
})
export class RealtimeModule {}
