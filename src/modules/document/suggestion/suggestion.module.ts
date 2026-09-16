import { Module } from '@nestjs/common';
import { SuggestionController } from './suggestion.controller';
import { SuggestionService } from './suggestion.service';
import { SuggestionRepository } from './suggestion.repository';
import { CoreModule } from '../core/core.module';

@Module({
  imports: [CoreModule],
  controllers: [SuggestionController],
  providers: [SuggestionService, SuggestionRepository],
  exports: [SuggestionService, SuggestionRepository],
})
export class SuggestionModule {}
