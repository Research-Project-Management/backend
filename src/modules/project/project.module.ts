import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module';
import { MemberModule } from './member/member.module';
import { InvitationModule } from './invitation/invitation.module';

@Module({
  imports: [CoreModule, MemberModule, InvitationModule],
  exports: [CoreModule, MemberModule, InvitationModule],
})
export class ProjectModule {}
