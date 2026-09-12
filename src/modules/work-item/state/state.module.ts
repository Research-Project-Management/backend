import { Module } from '@nestjs/common';
import { StateController } from './state.controller';
import { StateService } from './state.service';
import { StateRepository } from './state.repository';

@Module({
  imports: [],
  controllers: [StateController],
  providers: [StateService, StateRepository],
  exports: [StateService, StateRepository],
})
export class StateModule {}
