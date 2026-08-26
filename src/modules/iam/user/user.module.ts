import { Module } from '@nestjs/common';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { UserRepository } from './user.repository';
import { FederatedIdentityRepository } from './federated-identity.repository';

@Module({
  controllers: [UserController],
  providers: [UserService, UserRepository, FederatedIdentityRepository],
  exports: [UserService, UserRepository, FederatedIdentityRepository],
})
export class UserModule {}
