import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module';
import { MemberModule } from './member/member.module';

@Module({
  imports: [CoreModule, MemberModule],
  exports: [CoreModule, MemberModule],
})
export class ProjectModule {}
