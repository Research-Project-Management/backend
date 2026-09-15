import { Module } from '@nestjs/common';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';
import { CoreModule as DocumentCoreModule } from '../core/core.module';
import { CompilerModule } from '../compiler/compiler.module';
import { CoreModule as AppCoreModule } from '@/core/core.module';

@Module({
  imports: [DocumentCoreModule, CompilerModule, AppCoreModule],
  controllers: [ExportController],
  providers: [ExportService],
  exports: [ExportService],
})
export class ExportModule {}
