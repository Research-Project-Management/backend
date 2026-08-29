import { Module } from '@nestjs/common';
import { StateController } from './state.controller';
import { StateService } from './state.service';
import { StateRepository } from './state.repository';
import { CoreModule } from '../../../core/core.module';

@Module({
  imports: [CoreModule],
  controllers: [StateController],
  providers: [StateRepository, StateService],
  exports: [StateRepository, StateService],
})
export class StateModule {}
