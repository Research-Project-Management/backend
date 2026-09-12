import { Module } from '@nestjs/common';
import { MemberController } from './member.controller';
import { MemberService } from './member.service';
import { MemberRepository } from './member.repository';

@Module({
  imports: [],
  controllers: [MemberController],
  providers: [MemberService, MemberRepository],
  exports: [MemberService, MemberRepository],
})
export class MemberModule {}
