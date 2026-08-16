import { Module } from '@nestjs/common';
import { StickyController } from './sticky.controller';
import { StickyService } from './sticky.service';
import { StickyRepository } from './sticky.repository';

@Module({
  controllers: [StickyController],
  providers: [StickyService, StickyRepository],
  exports: [StickyService, StickyRepository],
})
export class StickyModule {}
