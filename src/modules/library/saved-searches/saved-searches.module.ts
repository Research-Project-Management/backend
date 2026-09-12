import { Module } from '@nestjs/common';
import { SavedSearchesController } from './saved-searches.controller';
import { SavedSearchesService } from './saved-searches.service';
import { SavedSearchesRepository } from './saved-searches.repository';
import { ConditionEvaluatorEngine } from './engines/condition-evaluator.engine';
import { CoreModule } from '../core/core.module';

@Module({
  imports: [CoreModule],
  controllers: [SavedSearchesController],
  providers: [
    SavedSearchesService,
    SavedSearchesRepository,
    ConditionEvaluatorEngine,
  ],
  exports: [
    SavedSearchesService,
    SavedSearchesRepository,
    ConditionEvaluatorEngine,
  ],
})
export class SavedSearchesModule {}
