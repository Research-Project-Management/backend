import { Module } from '@nestjs/common';
import { SuggestionController } from './suggestion.controller';
import { SuggestionService } from './suggestion.service';
import { SuggestionRepository } from './suggestion.repository';
import { PageModule } from '../page/page.module';
import { CollaborationModule } from '../collaboration/collaboration.module';

@Module({
  imports: [PageModule, CollaborationModule],
  controllers: [SuggestionController],
  providers: [SuggestionService, SuggestionRepository],
  exports: [SuggestionService, SuggestionRepository],
})
export class SuggestionModule {}
