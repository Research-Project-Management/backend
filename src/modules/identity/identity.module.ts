import { Global, Module } from '@nestjs/common';
import { UserModule } from './user/user.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { IdentityFacade } from './identity.facade';
import { IDENTITY_FACADE_TOKEN } from './core/interfaces/identity.interface';

/**
 * Root Identity Module (@Global)
 *
 * Encapsulates the entire Identity Domain. Only exposes the unified IdentityFacade
 * and presentation Authentication guards to outside modules.
 * Internal sub-modules (User, Audit) are strictly encapsulated.
 */
@Global()
@Module({
  imports: [UserModule, AuthModule, AuditModule],
  providers: [
    IdentityFacade,
    {
      provide: IDENTITY_FACADE_TOKEN,
      useExisting: IdentityFacade,
    },
  ],
  exports: [IdentityFacade, IDENTITY_FACADE_TOKEN, AuthModule],
})
export class IdentityModule {}
