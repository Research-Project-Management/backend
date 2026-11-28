import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module';
import { StateModule } from './state/state.module';
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
import { ActivityModule } from './activity/activity.module';
import { ChatModule } from './chat/chat.module';

@Module({
  imports: [
    AccessModule,
    CoreModule,
    StateModule,
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
    ActivityModule,
    ChatModule,
  ],
  exports: [
    AccessModule,
    CoreModule,
    StateModule,
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
    ActivityModule,
    ChatModule,
  ],
})
export class ProjectModule {}
