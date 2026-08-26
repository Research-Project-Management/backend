import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { CitationContextModule } from '../citation/citation.module';
import { ExportsService } from './exports.service';
import { ExportsController } from './exports.controller';

@Module({
  imports: [CoreModule, CitationContextModule],
  controllers: [ExportsController],
  providers: [ExportsService],
  exports: [ExportsService],
})
export class ExportsContextModule {}
