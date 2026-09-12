import { Module, forwardRef } from '@nestjs/common';
import { WorkItemController } from './work-item.controller';
import { WorkItemService } from './work-item.service';
import { WorkItemRepository } from './work-item.repository';
import { WorkItemIdHandler } from './handlers/work-item-id.handler';
import { WorkItemRankHandler } from './handlers/work-item-rank.handler';
import { WorkItemCloneHandler } from './handlers/work-item-clone.handler';
import { AssignmentModule } from '../assignment/assignment.module';

@Module({
  imports: [forwardRef(() => AssignmentModule)],
  controllers: [WorkItemController],
  providers: [
    WorkItemService,
    WorkItemRepository,
    WorkItemIdHandler,
    WorkItemRankHandler,
    WorkItemCloneHandler,
  ],
  exports: [
    WorkItemService,
    WorkItemRepository,
    WorkItemIdHandler,
    WorkItemRankHandler,
    WorkItemCloneHandler,
  ],
})
export class WorkItemCoreModule {}

// Backward compatibility alias
export const CoreModule = WorkItemCoreModule;
export type CoreModule = WorkItemCoreModule;
