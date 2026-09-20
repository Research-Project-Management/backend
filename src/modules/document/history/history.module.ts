import { Module } from '@nestjs/common';
import { HistoryController } from './history.controller';
import { HistoryService } from './history.service';
import { HistoryRepository } from './history.repository';
import { HistoryOpLogService } from './history-oplog.service';
import { PageModule } from '../page/page.module';
import { CollaborationModule } from '../collaboration/collaboration.module';

@Module({
  imports: [PageModule, CollaborationModule],
  controllers: [HistoryController],
  providers: [HistoryService, HistoryRepository, HistoryOpLogService],
  exports: [HistoryService, HistoryOpLogService],
})
export class HistoryModule {}
