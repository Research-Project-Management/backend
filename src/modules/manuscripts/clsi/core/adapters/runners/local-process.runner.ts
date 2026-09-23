/**
 * modules/manuscripts/clsi/core/adapters/runners/local-process.runner.ts
 * Executes commands on the host OS as child processes with Watchdog timeout control
 */

import { spawn } from 'child_process';
import {
  ISandboxRunner,
  ProcessExecutionOptions,
  ProcessExecutionResult,
} from '../../ports/runner.port';
import { Watchdog } from './watchdog';

export class LocalProcessRunner implements ISandboxRunner {
  readonly name = 'local-process';

  public async run(
    command: string,
    args: string[],
    options: ProcessExecutionOptions
  ): Promise<ProcessExecutionResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';

      const child = spawn(command, args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...(options.env || {}),
        },
        detached: process.platform !== 'win32',
        shell: false,
      });

      const watchdog = new Watchdog(child, options.timeoutMs ?? 30000);
      watchdog.arm(options.signal);

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('error', (err) => {
        watchdog.disarm();
        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr ? `${stderr}\n${err.message}` : err.message,
        });
      });

      child.on('close', (code) => {
        watchdog.disarm();
        if (watchdog.isAborted()) {
          resolve({
            exitCode: 137,
            stdout,
            stderr: stderr
              ? `${stderr}\nCompilation timed out or was canceled`
              : 'Compilation timed out or was canceled',
          });
          return;
        }

        resolve({
          exitCode: code ?? 0,
          stdout,
          stderr,
        });
      });
    });
  }
}
