import { Module, forwardRef } from '@nestjs/common';
import { WorkItemController } from './work-item.controller';
import { WorkItemService } from './work-item.service';
import { WorkItemRepository } from './work-item.repository';
import { CycleModule } from './cycle/cycle.module';
import { WorklogModule } from './worklog/worklog.module';
import { LabelModule } from './label/label.module';
import { TaskCommentModule } from './comment/comment.module';
import { ActivityModule } from '@/modules/activity/activity.module';

@Module({
  imports: [
    forwardRef(() => CycleModule),
    WorklogModule,
    LabelModule,
    TaskCommentModule,
    ActivityModule,
  ],
  controllers: [WorkItemController],
  providers: [WorkItemService, WorkItemRepository],
  exports: [
    WorkItemService,
    WorkItemRepository,
    CycleModule,
    WorklogModule,
    LabelModule,
    TaskCommentModule,
  ],
})
export class WorkItemModule {}

// Backward compatibility alias
export const TaskModule = WorkItemModule;
export type TaskModule = WorkItemModule;
export const WorkflowModule = WorkItemModule;
export type WorkflowModule = WorkItemModule;
