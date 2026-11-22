import { Global, Module } from '@nestjs/common';
import {
  NodeHardwareResourceProbe,
  SystemResourceGovernor,
} from './system-resource-governor';

@Global()
@Module({
  providers: [
    NodeHardwareResourceProbe,
    {
      provide: SystemResourceGovernor,
      useFactory: (probe: NodeHardwareResourceProbe) =>
        new SystemResourceGovernor(probe),
      inject: [NodeHardwareResourceProbe],
    },
  ],
  exports: [SystemResourceGovernor, NodeHardwareResourceProbe],
})
export class ResourceModule {}
