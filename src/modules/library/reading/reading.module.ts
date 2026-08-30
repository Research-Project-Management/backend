import { Module } from '@nestjs/common';
import { ReadingController } from './reading.controller';
import { ReadingService } from './reading.service';
import { ReadingRepository } from './reading.repository';
import { CoreModule } from '../../../core/core.module';

@Module({
  imports: [CoreModule],
  controllers: [ReadingController],
  providers: [ReadingRepository, ReadingService],
  exports: [ReadingService],
})
export class ReadingModule {}
