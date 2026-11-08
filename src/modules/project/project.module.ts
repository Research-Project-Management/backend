import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module';
import { StateModule } from './state/state.module';
import { LabelModule } from './label/label.module';
import { MemberModule } from './member/member.module';
import { InvitationModule } from './invitation/invitation.module';
import { StatusUpdateModule } from './status-update/status-update.module';
import { AccessModule } from './access/access.module';
import { FavoriteModule } from './favorite/favorite.module';
import { ArchiveModule } from './archive/archive.module';
import { WorkItemModule } from './work-item';
import { StickyModule } from './sticky/sticky.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { OverviewModule } from './overview/overview.module';
import { YourWorkModule } from './your-work/your-work.module';

@Module({
  imports: [
    AccessModule,
    CoreModule,
    StateModule,
    LabelModule,
    MemberModule,
    InvitationModule,
    StatusUpdateModule,
    FavoriteModule,
    ArchiveModule,
    WorkItemModule,
    StickyModule,
    AnalyticsModule,
    OverviewModule,
    YourWorkModule,
  ],
  exports: [
    AccessModule,
    CoreModule,
    StateModule,
    LabelModule,
    MemberModule,
    InvitationModule,
    StatusUpdateModule,
    FavoriteModule,
    ArchiveModule,
    WorkItemModule,
    StickyModule,
    AnalyticsModule,
    OverviewModule,
    YourWorkModule,
  ],
})
export class ProjectModule {}
