import { Module } from '@nestjs/common';
import { WorkItemCoreModule } from './core/core.module';
import { CycleModule } from './cycle/cycle.module';
import { LabelModule } from './label/label.module';
import { CommentModule } from './comment/comment.module';
import { StateModule } from './state/state.module';
import { AssignmentModule } from './assignment/assignment.module';
import { RelationModule } from './relation/relation.module';
import { UpdateModule } from './update/update.module';
import { ExportModule } from './export/export.module';
import { HistoryModule } from './history/history.module';
import { ViewModule } from './view/view.module';
import { PropertyModule } from './property/property.module';
import { AttachmentModule } from './attachment/attachment.module';
import { DraftModule } from './draft/draft.module';
import { ArchiveModule } from './archive/archive.module';
import { WorklogModule } from './worklog/worklog.module';
import { TemplateModule } from './template/template.module';

@Module({
  imports: [
    WorkItemCoreModule,
    CycleModule,
    LabelModule,
    CommentModule,
    StateModule,
    AssignmentModule,
    RelationModule,
    UpdateModule,
    ExportModule,
    HistoryModule,
    ViewModule,
    PropertyModule,
    AttachmentModule,
    DraftModule,
    ArchiveModule,
    WorklogModule,
    TemplateModule,
  ],
  exports: [
    WorkItemCoreModule,
    CycleModule,
    LabelModule,
    CommentModule,
    StateModule,
    AssignmentModule,
    RelationModule,
    UpdateModule,
    ExportModule,
    HistoryModule,
    ViewModule,
    PropertyModule,
    AttachmentModule,
    DraftModule,
    ArchiveModule,
    WorklogModule,
    TemplateModule,
  ],
})
export class WorkItemModule {}

// Backward compatibility aliases
export const TaskModule = WorkItemModule;
export type TaskModule = WorkItemModule;
export const WorkflowModule = WorkItemModule;
export type WorkflowModule = WorkItemModule;

