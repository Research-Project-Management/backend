import { Module } from '@nestjs/common';
import { LatexController } from './latex.controller';
import { LatexService } from './latex.service';

@Module({
  controllers: [LatexController],
  providers: [LatexService],
  exports: [LatexService],
})
export class LatexModule {}
