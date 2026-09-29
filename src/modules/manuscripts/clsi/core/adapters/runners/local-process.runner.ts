/**
 * modules/manuscripts/clsi/core/adapters/runners/local-process.runner.ts
 * Executes commands on the host OS as child processes with Watchdog timeout control
 */

import { ChildProcess, spawn } from 'child_process';
import {
  ISandboxRunner,
  ProcessExecutionOptions,
  ProcessExecutionResult,
} from '../../ports/runner.port';
import { Watchdog, killProcessGroup } from './watchdog';

export class LocalProcessRunner implements ISandboxRunner {
  readonly name = 'local-process';

  // Global registry of running compiler child processes to prevent orphaned zombie processes
  private static readonly activeChildProcesses = new Set<ChildProcess>();
  private static shutdownHooksRegistered = false;

  private static registerShutdownHooks(): void {
    if (this.shutdownHooksRegistered) return;
    this.shutdownHooksRegistered = true;

    const cleanup = () => {
      for (const child of this.activeChildProcesses) {
        if (child.pid && !child.killed) {
          killProcessGroup(child.pid, true);
        }
      }
      this.activeChildProcesses.clear();
    };

    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
    process.once('exit', cleanup);
  }

  public async run(
    command: string,
    args: string[],
    options: ProcessExecutionOptions,
  ): Promise<ProcessExecutionResult> {
    LocalProcessRunner.registerShutdownHooks();

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

      LocalProcessRunner.activeChildProcesses.add(child);

      const watchdog = new Watchdog(child, options.timeoutMs ?? 240000);
      watchdog.arm(options.signal);

      child.stdout?.on('data', (data) => {
        const str = data.toString();
        stdout += str;
        options.onLogChunk?.(str);
      });

      child.stderr?.on('data', (data) => {
        const str = data.toString();
        stderr += str;
        options.onLogChunk?.(str);
      });

      child.on('error', (err) => {
        LocalProcessRunner.activeChildProcesses.delete(child);
        watchdog.disarm();
        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr ? `${stderr}\n${err.message}` : err.message,
        });
      });

      child.on('close', (code) => {
        LocalProcessRunner.activeChildProcesses.delete(child);
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
