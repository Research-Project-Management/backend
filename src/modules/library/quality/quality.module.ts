import { Module } from '@nestjs/common';
import { QualityController } from './quality.controller';
import { QualityService } from './quality.service';
import { ItemsModule } from '../items/items.module';
import { CiteModule } from '../cite/cite.module';

@Module({
  imports: [ItemsModule, CiteModule],
  controllers: [QualityController],
  providers: [QualityService],
  exports: [QualityService],
})
export class QualityModule {}
