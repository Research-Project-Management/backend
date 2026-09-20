import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module';
import { StateModule } from './state/state.module';
import { LabelModule } from './label/label.module';
import { TemplateModule } from './template/template.module';
import { FavoriteModule } from './favorite/favorite.module';
import { ArchiveModule } from './archive/archive.module';
import { ProjectAnalyticsModule } from './analytics/analytics.module';
import { MemberModule } from './member/member.module';
import { InvitationModule } from './invitation/invitation.module';
import { OverviewModule } from './overview/overview.module';
import { StatusUpdateModule } from './status-update/status-update.module';

import { AccessModule } from './access/access.module';

@Module({
  imports: [
    AccessModule,
    CoreModule,
    StateModule,
    LabelModule,
    TemplateModule,
    FavoriteModule,
    ArchiveModule,
    ProjectAnalyticsModule,
    MemberModule,
    InvitationModule,
    OverviewModule,
    StatusUpdateModule,
  ],
  exports: [
    AccessModule,
    CoreModule,
    StateModule,
    LabelModule,
    TemplateModule,
    FavoriteModule,
    ArchiveModule,
    ProjectAnalyticsModule,
    MemberModule,
    InvitationModule,
    OverviewModule,
    StatusUpdateModule,
  ],
})
export class ProjectModule {}
