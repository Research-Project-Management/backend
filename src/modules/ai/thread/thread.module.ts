import { Module } from '@nestjs/common';
import { ThreadController } from './thread.controller';
import { ThreadService } from './thread.service';
import { ThreadRepository } from './thread.repository';

@Module({
  controllers: [ThreadController],
  providers: [ThreadService, ThreadRepository],
  exports: [ThreadService, ThreadRepository],
})
export class ThreadModule {}
