import { Module } from '@nestjs/common';
import { TagsController } from './tags.controller';
import { TagsRepository } from './tags.repository';
import { TagsService } from './tags.service';
import { CoreModule } from '../../../core/core.module';
import { OutboxModule } from '../outbox/outbox.module';

@Module({
  imports: [CoreModule, OutboxModule],
  controllers: [TagsController],
  providers: [TagsRepository, TagsService],
  exports: [TagsService],
})
export class TagsModule {}
