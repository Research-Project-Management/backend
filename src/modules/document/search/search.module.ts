import { Module } from '@nestjs/common';
import { SearchService } from './search.service';
import { SearchController } from './search.controller';
import { PageModule } from '../page/page.module';
import { CollaborationModule } from '../collaboration/collaboration.module';
import { HistoryModule } from '../history/history.module';
import { CoreModule } from '@/core/core.module';

@Module({
  imports: [CoreModule, PageModule, CollaborationModule, HistoryModule],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
