import { Module } from '@nestjs/common';
import { CollectionsRepository } from './collections.repository';
import { CoreModule } from '../../../core/core.module';
import { LibraryFeatureFlagsService } from '../common/library-feature-flags';

@Module({
  imports: [CoreModule],
  providers: [CollectionsRepository, LibraryFeatureFlagsService],
  exports: [CollectionsRepository],
})
export class CollectionsContextModule {}
