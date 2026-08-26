import { Global, Module } from '@nestjs/common';
import { UserModule } from './user/user.module';
import { AuthnModule } from './authn/authn.module';
import { AuthzModule } from './authz/authz.module';
import { AuditModule } from './audit/audit.module';

@Global()
@Module({
  imports: [UserModule, AuthnModule, AuthzModule, AuditModule],
  exports: [UserModule, AuthnModule, AuthzModule, AuditModule],
})
export class IamModule {}
