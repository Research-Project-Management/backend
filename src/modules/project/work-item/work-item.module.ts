import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module';
import { WorkItemFacade } from './work-item.facade';

import { LabelModule } from './label/label.module';
import { CommentModule } from './comment/comment.module';
import { StateModule } from './state/state.module';
import { AssignmentModule } from './assignment/assignment.module';
import { RelationModule } from './relation/relation.module';
import { HistoryModule } from './history/history.module';
import { AttachmentModule } from './attachment/attachment.module';
import { DraftModule } from './draft/draft.module';
import { ArchiveModule } from './archive/archive.module';

@Module({
  imports: [
    CoreModule,
    LabelModule,
    CommentModule,
    StateModule,
    AssignmentModule,
    RelationModule,
    HistoryModule,
    AttachmentModule,
    DraftModule,
    ArchiveModule,
  ],
  providers: [WorkItemFacade],
  exports: [
    CoreModule,
    WorkItemFacade,
    LabelModule,
    CommentModule,
    StateModule,
    AssignmentModule,
    RelationModule,
    HistoryModule,
    AttachmentModule,
    DraftModule,
    ArchiveModule,
  ],
})
export class WorkItemModule {}
