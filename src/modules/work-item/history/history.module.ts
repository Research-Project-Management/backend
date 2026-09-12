import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core/database/prisma.module';
import { HistoryController } from './history.controller';
import { HistoryRepository } from './history.repository';
import { HistoryService } from './history.service';

@Module({
  imports: [PrismaModule],
  controllers: [HistoryController],
  providers: [HistoryRepository, HistoryService],
  exports: [HistoryService, HistoryRepository],
})
export class HistoryModule {}

