import { Global, Module } from '@nestjs/common';
import { UserModule } from './user/user.module';
import { AuthnModule } from './authn/authn.module';
import { AuthzModule } from './authz/authz.module';

@Global()
@Module({
  imports: [UserModule, AuthnModule, AuthzModule],
  exports: [UserModule, AuthnModule, AuthzModule],
})
export class IamModule {}
