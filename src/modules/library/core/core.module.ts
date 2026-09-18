import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SsrfGuardService } from './services/ssrf-guard.service';

@Module({
  imports: [ConfigModule],
  controllers: [],
  providers: [SsrfGuardService],
  exports: [SsrfGuardService],
})
export class CoreModule {}
