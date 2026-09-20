import { Module } from '@nestjs/common';
import { InvitationController } from './invitation.controller';
import { InvitationService } from './invitation.service';
import { InvitationRepository } from './invitation.repository';
import { VerifiedEmailGuard } from '@/modules/identity/auth';

@Module({
  controllers: [InvitationController],
  providers: [InvitationService, InvitationRepository, VerifiedEmailGuard],
  exports: [InvitationService, InvitationRepository],
})
export class InvitationModule {}
