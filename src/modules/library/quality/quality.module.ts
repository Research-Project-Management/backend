import { Module } from '@nestjs/common';
import { QualityController } from './quality.controller';
import { QualityService } from './quality.service';
import { PaperModule } from '../paper/paper.module';

@Module({
  imports: [PaperModule],
  controllers: [QualityController],
  providers: [QualityService],
  exports: [QualityService],
})
export class QualityModule {}
