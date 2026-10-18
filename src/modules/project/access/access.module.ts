import { Global, Module } from '@nestjs/common';
import { AccessRepository } from './access.repository';
import { AccessService } from './access.service';
import { ProjectAccessGuard } from './guards/project-access.guard';
import { OperatorGuard } from './guards/operator.guard';
import { AccessController } from './access.controller';
import { ProjectResourceResolver } from './resolvers/project-resource.resolver';
import { AccessConfigService } from './config/access.config';

@Global()
@Module({
  controllers: [AccessController],
  providers: [
    AccessRepository,
    AccessService,
    ProjectAccessGuard,
    OperatorGuard,
    ProjectResourceResolver,
    AccessConfigService,
  ],
  exports: [
    AccessRepository,
    AccessService,
    ProjectAccessGuard,
    OperatorGuard,
    ProjectResourceResolver,
    AccessConfigService,
  ],
})
export class AccessModule {}
