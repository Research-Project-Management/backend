import { Module } from '@nestjs/common';
import { SynctexController } from './synctex.controller';
import { SynctexService } from './synctex.service';
import { CoreModule as AppCoreModule } from '@/core/core.module';

@Module({
  imports: [AppCoreModule],
  controllers: [SynctexController],
  providers: [SynctexService],
  exports: [SynctexService],
})
export class SynctexModule {}
