import { Module } from '@nestjs/common';
import {
  ReadingController,
  ReadingBatchController,
} from './reading.controller';
import { ReadingService } from './reading.service';
import { ReadingRepository } from './reading.repository';
import { CoreModule } from '../../../core/core.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ItemsModule } from '../items/items.module';

@Module({
  imports: [CoreModule, OutboxModule, ItemsModule],
  controllers: [ReadingController, ReadingBatchController],
  providers: [ReadingRepository, ReadingService],
  exports: [ReadingService],
})
export class ReadingModule {}
