import { Global, Module } from '@nestjs/common';
import { UserModule } from './user/user.module';
import { AuthenticationModule } from './authentication/authentication.module';
import { AuthorizationModule } from './authorization/authorization.module';

@Global()
@Module({
  imports: [UserModule, AuthenticationModule, AuthorizationModule],
  exports: [UserModule, AuthenticationModule, AuthorizationModule],
})
export class IamModule {}
