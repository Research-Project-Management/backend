import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core/database/prisma.module';
import { ExportService } from './export.service';
import { ExportController } from './export.controller';

@Module({
  imports: [PrismaModule],
  controllers: [ExportController],
  providers: [ExportService],
  exports: [ExportService],
})
export class ExportModule {}
