/**
 * IAM Core Module
 * Encapsulates the IamService facade to expose a unified interface
 * for authentication, authorization, and user management.
 */
import { Module } from '@nestjs/common';
import { IamService } from './iam.service';
import { UserModule } from '../user/user.module';
import { AuthnModule } from '../authn/authn.module';
import { AuthzModule } from '../authz/authz.module';

@Module({
  imports: [UserModule, AuthnModule, AuthzModule],
  providers: [IamService],
  exports: [IamService],
})
export class IamCoreModule {}
