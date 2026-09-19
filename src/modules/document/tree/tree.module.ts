import { Module } from '@nestjs/common';
import { TreeController } from './tree.controller';
import { TreeService } from './tree.service';
import { TreeRepository } from './tree.repository';
import { CoreModule as AppCoreModule } from '@/core/core.module';

@Module({
  imports: [AppCoreModule],
  controllers: [TreeController],
  providers: [TreeService, TreeRepository],
  exports: [TreeService, TreeRepository],
})
export class TreeModule {}

export const NodeModule = TreeModule;
export type NodeModule = TreeModule;
