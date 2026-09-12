import { Module } from '@nestjs/common';
import { StateController, StateBatchController } from './state.controller';
import { StateService } from './state.service';
import { StateRepository } from './state.repository';
import { CoreModule } from '../../../core/core.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ItemsModule } from '../items/items.module';

@Module({
  imports: [CoreModule, OutboxModule, ItemsModule],
  controllers: [StateController, StateBatchController],
  providers: [StateRepository, StateService],
  exports: [StateService, StateRepository],
})
export class StateModule {}
