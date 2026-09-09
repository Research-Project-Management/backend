import { Module } from '@nestjs/common';
import { LatexController } from './latex.controller';
import { LatexService } from './latex.service';
import { PageModule } from '../page/page.module';
import { ExportsModule } from '../../library/exports/exports.module';
import { CoreModule } from '../../../core/core.module';

@Module({
  imports: [PageModule, ExportsModule, CoreModule],
  controllers: [LatexController],
  providers: [LatexService],
  exports: [LatexService],
})
export class LatexModule {}
