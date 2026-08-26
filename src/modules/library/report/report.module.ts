import { Module } from '@nestjs/common';
import { ReportController } from './report.controller';
import { ReportService } from './report.service';
import { ItemsModule } from '../items/items.module';
import { CiteModule } from '../cite/cite.module';

@Module({
  imports: [ItemsModule, CiteModule],
  controllers: [ReportController],
  providers: [ReportService],
  exports: [ReportService],
})
export class ReportModule {}
