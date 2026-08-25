import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { LibraryReportController } from './report.controller';
import { LibraryReportService } from './report.service';

@Module({
  imports: [CatalogModule],
  controllers: [LibraryReportController],
  providers: [LibraryReportService],
  exports: [LibraryReportService],
})
export class LibraryReportModule {}
