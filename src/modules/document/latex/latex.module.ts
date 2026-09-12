import { Module } from '@nestjs/common';
import { LatexController } from './latex.controller';
import { LatexService } from './latex.service';
import { CoreModule as DocumentCoreModule } from '../core/core.module';
import { ExportsModule } from '../../library/exports/exports.module';
import { CoreModule } from '../../../core/core.module';

@Module({
  imports: [DocumentCoreModule, ExportsModule, CoreModule],
  controllers: [LatexController],
  providers: [LatexService],
  exports: [LatexService],
})
export class LatexModule {}
