import { Module } from '@nestjs/common';
import { LatexController } from './latex.controller';
import { LatexService } from './latex.service';
import { PageModule } from '../page/page.module';

@Module({
  imports: [PageModule],
  controllers: [LatexController],
  providers: [LatexService],
  exports: [LatexService],
})
export class LatexModule {}
