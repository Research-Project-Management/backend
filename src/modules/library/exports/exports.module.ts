import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { CitationModule } from '../citation/citation.module';
import { ItemsModule } from '../items/items.module';
import { ExportsService } from './exports.service';
import { ExportsController } from './exports.controller';

@Module({
  imports: [CoreModule, CitationModule, ItemsModule],
  controllers: [ExportsController],
  providers: [ExportsService],
  exports: [ExportsService],
})
export class ExportsModule {}
