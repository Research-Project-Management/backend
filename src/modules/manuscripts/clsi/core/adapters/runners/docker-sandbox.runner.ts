/**
 * modules/manuscripts/clsi/core/adapters/runners/docker-sandbox.runner.ts
 * Spawns isolated Docker containers matching Overleaf's production DockerRunner behavior:
 * --net=none, memory & cpu limits, dropped capabilities, non-root user.
 */

import {
  ISandboxRunner,
  ProcessExecutionOptions,
  ProcessExecutionResult,
} from '../../ports/runner.port';
import { LocalProcessRunner } from './local-process.runner';

export class DockerSandboxRunner implements ISandboxRunner {
  readonly name = 'docker-sandbox';
  private readonly localRunner = new LocalProcessRunner();

  constructor(
    private readonly dockerImage: string = 'sharelatex/clsi:latest',
    private readonly memoryLimit: string = '1024m',
    private readonly cpuLimit: string = '1.0'
  ) {}

  public async run(
    command: string,
    args: string[],
    options: ProcessExecutionOptions
  ): Promise<ProcessExecutionResult> {
    const dockerArgs = [
      'run',
      '--rm',
      '--net=none',
      `--memory=${this.memoryLimit}`,
      `--cpus=${this.cpuLimit}`,
      '--pids-limit=100',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '-v',
      `${options.cwd}:/compile:rw`,
      '-w',
      '/compile',
      this.dockerImage,
      command,
      ...args,
    ];

    const result = await this.localRunner.run('docker', dockerArgs, options);

    if (
      result.exitCode !== 0 &&
      result.stderr.includes('docker: command not found')
    ) {
      throw new Error('Docker is not installed or available on this system');
    }

    return result;
  }
}
