import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core/database/prisma.module';
import { WorklogController } from './worklog.controller';
import { WorklogRepository } from './worklog.repository';
import { WorklogService } from './worklog.service';

@Module({
  imports: [PrismaModule],
  controllers: [WorklogController],
  providers: [WorklogRepository, WorklogService],
  exports: [WorklogService, WorklogRepository],
})
export class WorklogModule {}
