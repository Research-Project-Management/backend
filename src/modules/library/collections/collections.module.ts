import { Module, forwardRef } from '@nestjs/common';
import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';
import { CollectionsRepository } from './collections.repository';
import { CitationModule } from '../citation/citation.module';

@Module({
  imports: [forwardRef(() => CitationModule)],
  controllers: [CollectionsController],
  providers: [CollectionsService, CollectionsRepository],
  exports: [CollectionsService, CollectionsRepository],
})
export class CollectionsModule {}
