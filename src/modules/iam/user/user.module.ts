/**
 * User Module
 * Provides user profile management, personal settings, resource statistics,
 * user search, and third-party identity bindings.
 */
import { Module } from '@nestjs/common';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { UserRepository } from './user.repository';
import { IdentityRepository } from './identity.repository';

@Module({
  controllers: [UserController],
  providers: [
    UserService,
    UserRepository,
    IdentityRepository,
  ],
  exports: [
    UserService,
    UserRepository,
    IdentityRepository,
  ],
})
export class UserModule {}
