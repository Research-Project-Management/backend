import { Global, Module } from '@nestjs/common';
import { AccessRepository } from './access.repository';
import { AccessService } from './access.service';
import { ProjectAccessGuard } from './guards/project-access.guard';
import { AccessController } from './access.controller';

@Global()
@Module({
  controllers: [AccessController],
  providers: [AccessRepository, AccessService, ProjectAccessGuard],
  exports: [AccessRepository, AccessService, ProjectAccessGuard],
})
export class AccessModule {}
