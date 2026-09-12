/**
 * Global IAM Module
 * Aggregates Identity, Authentication, and Authorization submodules.
 * Exports IamService as the centralized gateway facade for external consumers.
 */
import { Global, Module } from '@nestjs/common';
import { UserModule } from './user/user.module';
import { AuthnModule } from './authn/authn.module';
import { AuthzModule } from './authz/authz.module';
import { IamCoreModule } from './core/iam.module';
@Global()
@Module({
  imports: [UserModule, AuthnModule, AuthzModule, IamCoreModule],
  exports: [UserModule, AuthnModule, AuthzModule, IamCoreModule],
})
export class IamModule {}
