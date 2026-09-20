import { Module } from '@nestjs/common';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';
import { PageModule } from '../page/page.module';
import { CompilerModule } from '../compiler/compiler.module';
import { AssetModule } from '../asset/asset.module';
import { CoreModule as AppCoreModule } from '@/core/core.module';

@Module({
  imports: [PageModule, CompilerModule, AssetModule, AppCoreModule],
  controllers: [ExportController],
  providers: [ExportService],
  exports: [ExportService],
})
export class ExportModule {}
