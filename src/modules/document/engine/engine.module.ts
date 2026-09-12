import { Module } from '@nestjs/common';
import { EngineController } from './engine.controller';
import { EngineService } from './engine.service';
import { LatexModule } from '../latex/latex.module';
import { CoreModule } from '../core/core.module';
import { HistoryModule } from '../history/history.module';

@Module({
  imports: [LatexModule, CoreModule, HistoryModule],
  controllers: [EngineController],
  providers: [EngineService],
  exports: [EngineService],
})
export class EngineModule {}
