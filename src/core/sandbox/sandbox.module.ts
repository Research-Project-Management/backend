import { Module } from '@nestjs/common';
import { LocalSandboxRunnerService } from './local-sandbox-runner.service';
import { SANDBOX_RUNNER_TOKEN } from './sandbox.types';

@Module({
  providers: [
    LocalSandboxRunnerService,
    {
      provide: SANDBOX_RUNNER_TOKEN,
      useClass: LocalSandboxRunnerService,
    },
  ],
  exports: [LocalSandboxRunnerService, SANDBOX_RUNNER_TOKEN],
})
export class SandboxModule {}
