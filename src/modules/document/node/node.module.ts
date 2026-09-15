import { Module } from '@nestjs/common';
import { NodeController } from './node.controller';
import { NodeService } from './node.service';
import { NodeRepository } from './node.repository';
import { CoreModule as AppCoreModule } from '@/core/core.module';

@Module({
  imports: [AppCoreModule],
  controllers: [NodeController],
  providers: [NodeService, NodeRepository],
  exports: [NodeService, NodeRepository],
})
export class NodeModule {}

export const TreeModule = NodeModule;
export type TreeModule = NodeModule;
